// Hosted Windows runner only: real installed app -> next NSIS version -> relaunch.
// Uses a newly created runner profile, never a person's existing planner data.
// Surface setup/finalization failures too; the main scenario already annotates its errors.
process.on('uncaughtException', error => {
 const text=String(error.stack||error.message||error).slice(0,12000);
 console.error('::error title=Updater test setup or cleanup::'+text.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));
 process.exit(1);
});
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {_electron}=require('playwright');
const asar=require('@electron/asar'),yaml=require('js-yaml');
assert(process.platform==='win32' && process.env.CI==='true' && process.env.RUNNER_OS==='Windows','Run only in a fresh hosted Windows CI job');
const executable=process.env.PLANNER_EXECUTABLE;
const feed=process.env.PLANNER_UPDATE_FEED_DIR;
const baseDist=process.env.PLANNER_BASE_DIST;
const baseVersion=process.env.PLANNER_BASE_VERSION;
const nextVersion=process.env.PLANNER_EXPECTED_NEXT_VERSION;
assert(executable&&feed&&baseDist&&baseVersion&&nextVersion);
const userData=path.join(process.env.APPDATA,'my-planner');
assert(!fs.existsSync(userData),'Refusing to use an existing default planner profile');
fs.mkdirSync(userData,{recursive:true});fs.writeFileSync(path.join(userData,'update-e2e-owner.marker'),'created by this hosted CI test');
const out=path.join(__dirname,'../test-results/update-e2e');fs.mkdirSync(out,{recursive:true});
const report={baseVersion,nextVersion,passed:[],errors:[],requests:[]};
const updateConfig=path.join(path.dirname(executable),'resources/app-update.yml');
const originalConfig=fs.readFileSync(updateConfig);
const metadata=yaml.load(fs.readFileSync(path.join(feed,'latest.yml'),'utf8'));
assert.equal(metadata.version,nextVersion);
for(const file of metadata.files)file.url='v'+nextVersion+'/'+file.url;
if(metadata.path)metadata.path='v'+nextVersion+'/'+metadata.path;
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;report.requests.push(name);
 if(name==='/latest.yml'){res.setHeader('Content-Type','text/yaml');res.end(yaml.dump(metadata));return;}
 const match=/^\/v([^/]+)\/(MyPlanner-Setup\.exe(?:\.blockmap)?)$/.exec(name);
 const dir=match && (match[1]===nextVersion?feed:match[1]===baseVersion?baseDist:null);
 const file=dir && path.join(dir,match[2]);
 if(!file||!fs.existsSync(file)){res.writeHead(404).end();return;}
 res.setHeader('Content-Length',fs.statSync(file).size);fs.createReadStream(file).pipe(res);
});
let app,page,held;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(500);}throw Error(label);}
const record=s=>{report.passed.push(s);console.log('PASS',s)};
function processes(){
 const script="[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-Process -Name MyPlanner -ErrorAction SilentlyContinue | Select-Object Id,Path,MainWindowTitle) | ConvertTo-Json -Compress";
 const text=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'}).trim();
 if(!text)return [];const data=JSON.parse(text);return Array.isArray(data)?data:[data];
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config=yaml.load(originalConfig.toString());delete config.owner;delete config.repo;delete config.releaseType;config.provider='generic';config.url='http://127.0.0.1:'+server.address().port;
 // Only this temporary installation uses the test feed. Published installer unchanged.
 fs.writeFileSync(updateConfig,yaml.dump(config));
 // Manual local-feed checking remains enabled; omit periodic GitHub polling in CI.
 const updateEnv={...process.env,CI:'true',PLANNER_DISABLE_AUTO_UPDATE:'1'};
 app=await _electron.launch({executablePath:executable,args:[],env:updateEnv,timeout:30000});page=await app.firstWindow();
 await page.waitForFunction(()=>window.storage&&document.querySelector('#homeBody')?.children.length);
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),userData);
 assert.equal(await app.evaluate(({app})=>app.getVersion()),baseVersion);
 assert.equal((await page.evaluate(()=>window.storage.load())).todos.length,0);
 await page.locator('[data-nav="todos"]').click();await page.locator('#todoNew').fill('E2E saved task');await page.locator('#todoAdd button[type=submit]').click();
 const dataFile=path.join(userData,'planner-data.json');
 await until(()=>fs.existsSync(dataFile)&&JSON.parse(fs.readFileSync(dataFile)).todos.some(t=>t.title==='E2E saved task'),'Initial task not persisted');
 await page.locator('[data-nav="settings"]').click();
 // The startup timer may already have started or completed the download.
 const initial=await page.evaluate(()=>window.plannerApp.updates.getState());
 if(['idle','up-to-date','error'].includes(initial.status))await page.evaluate(()=>window.plannerApp.updates.check());
 await page.locator('#update-install').waitFor({state:'visible',timeout:120000});
 const ready=await page.evaluate(()=>window.plannerApp.updates.getState());assert.equal(ready.version,nextVersion);record('Real installed app downloaded next NSIS version with generated metadata');
 // Save a pending edit into a blocked target; installing must not close the app.
 held=dataFile+'.held';fs.renameSync(dataFile,held);fs.mkdirSync(dataFile);
 await page.locator('[data-nav="todos"]').click();await page.locator('#todoNew').fill('E2E pending task');await page.locator('#todoAdd button[type=submit]').click();
 await page.locator('#saveStatus[data-state="error"]').waitFor({state:'visible'});
 await page.locator('[data-nav="settings"]').click();await page.locator('#update-install').click();
 await page.waitForFunction(()=>document.querySelector('#update-status').textContent.includes('저장 완료를 확인하지 못해'));
 assert.equal(await app.evaluate(({app})=>app.getVersion()),baseVersion);record('Real filesystem save error blocks updater installation and keeps original app running');
 await page.screenshot({path:path.join(out,'save-blocked.png')});
 fs.rmdirSync(dataFile);fs.renameSync(held,dataFile);held=null;
 const closed=app.waitForEvent('close',{timeout:30000});
 await page.locator('#update-install').click().catch(e=>{if(!/closed|destroyed/i.test(e.message))throw e});await closed;app=null;
 await until(()=>processes().some(p=>p.Path?.toLowerCase()===executable.toLowerCase()&&p.MainWindowTitle?.includes('v'+nextVersion)),'New app did not automatically relaunch with expected version');
 assert.equal(JSON.parse(asar.extractFile(path.join(path.dirname(executable),'resources/app.asar'),'package.json')).version,nextVersion);
 const persisted=JSON.parse(fs.readFileSync(dataFile));assert(persisted.todos.some(t=>t.title==='E2E saved task'));assert(persisted.todos.some(t=>t.title==='E2E pending task'));
 assert(fs.readdirSync(path.join(userData,'backups')).some(n=>n.endsWith('.json')));
 record('Actual NSIS update/relaunch reaches next version and retains both tasks plus local backups');
})().catch(async error=>{
 report.errors.push({message:error.message,stack:error.stack});console.error('::error title=Installed update integration::'+error.stack.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A'));process.exitCode=1;
 if(page)try{await page.screenshot({path:path.join(out,'failure.png')})}catch{}
}).finally(async()=>{
 if(held)try{fs.rmdirSync(path.join(userData,'planner-data.json'));fs.renameSync(held,path.join(userData,'planner-data.json'))}catch{}
 if(app)try{await app.close()}catch{}
 try{for(const p of processes())if(p.Path?.toLowerCase()===executable.toLowerCase())execFileSync('taskkill.exe',['/PID',String(p.Id),'/T','/F'],{stdio:'ignore'})}catch{}
 if(fs.existsSync(updateConfig))fs.writeFileSync(updateConfig,originalConfig);
 await new Promise(r=>server.close(r));
 fs.writeFileSync(path.join(__dirname,'../test-results/update-e2e.json'),JSON.stringify(report,null,2));
 if(fs.existsSync(path.join(userData,'update-e2e-owner.marker')))fs.rmSync(userData,{recursive:true,force:true});
});
