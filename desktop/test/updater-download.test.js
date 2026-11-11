// Actual electron-updater + local HTTP fixture. Never executes the downloaded bytes.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {NsisUpdater}=require('electron-updater');
const {ElectronHttpExecutor}=require('electron-updater/out/electronHttpExecutor');
// Electron 전송기의 실제 해시 검사를 쓰되, 요청은 테스트 loopback 서버로만 제한합니다.
class FixtureHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(Number(options.port), server.address().port);
    assert.equal(options.protocol, 'http:');
    return http.request(options, callback);
  }
}
const {createUpdateController}=require('../updater');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'planner-update-download-'));
const payload=Buffer.from('TEST FIXTURE ONLY - not an executable, never install');
const digest=crypto.createHash('sha512').update(payload).digest('base64');
let version='0.1.2',badHash=false,downloads=0;
const server=http.createServer((req,res)=>{
 if(req.url.split('?')[0].endsWith('latest-linux.yml')||req.url.split('?')[0].endsWith('latest.yml')){
  res.setHeader('Content-Type','text/yaml');res.end(`version: ${version}\nfiles:\n  - url: MyPlanner-Setup.exe\n    sha512: ${badHash?Buffer.alloc(64).toString('base64'):digest}\n    size: ${payload.length}\npath: MyPlanner-Setup.exe\nsha512: ${badHash?Buffer.alloc(64).toString('base64'):digest}\nreleaseDate: 2026-11-11T00:00:00.000Z\n`);
 }else if(req.url==='/MyPlanner-Setup.exe'){downloads++;res.setHeader('Content-Length',payload.length);res.end(payload)}else { console.error('TEST ROUTE NOT FOUND',req.url); res.writeHead(404).end(); }
});
async function waitFor(fn){const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error('Update transport did not settle');}
let counter=0;
function client(){
 const dir=path.join(temp,String(++counter));fs.mkdirSync(dir);
 const config=path.join(dir,'app-update.yml');fs.writeFileSync(config,'updaterCacheDirName: fixture\n');
 const app={version:'0.1.1',name:'my-planner-fixture',isPackaged:true,userDataPath:dir,baseCachePath:dir,appUpdateConfigPath:config,whenReady:()=>Promise.resolve(),onQuit:()=>{},quit:()=>{throw Error('Fixture must never quit/install')}};
 const updater=new NsisUpdater(null,app);const errors=[];updater.on('error', e=>errors.push({code:e.code,message:e.message}));updater.httpExecutor=new FixtureHttpExecutor();updater.setFeedURL({provider:'generic',url:'http://127.0.0.1:'+server.address().port});updater.disableDifferentialDownload=true;
 let installed=0;const controller=createUpdateController({updater,currentVersion:'0.1.1',prepareInstall:async()=>'',performInstall:()=>installed++,installFailed:()=>{}});
 return {updater,controller,errors,installed:()=>installed};
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let f=client();await f.controller.check();await waitFor(()=>['ready','error'].includes(f.controller.getState().status));assert.equal(f.controller.getState().status,'ready',JSON.stringify(f.errors));assert.equal(f.installed(),0);assert.equal(downloads,1);assert.deepEqual(fs.readFileSync(f.updater.installerPath),payload);f.controller.dispose();console.log('PASS real electron-updater metadata/download/SHA512: downloaded, not installed');
 badHash=true;f=client();await f.controller.check();await waitFor(()=>f.controller.getState().status==='error');assert.equal(f.installed(),0);assert.equal(f.controller.getState().status,'error');assert(f.errors.some(e=>e.code==='ERR_CHECKSUM_MISMATCH'),JSON.stringify(f.errors));f.controller.dispose();console.log('PASS real electron-updater rejects corrupted download checksum');
 badHash=false;version='0.1.0';const before=downloads;f=client();await f.controller.check();await waitFor(()=>f.controller.getState().status==='up-to-date');assert.equal(downloads,before);f.controller.dispose();console.log('PASS real electron-updater refuses version downgrade');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})});
