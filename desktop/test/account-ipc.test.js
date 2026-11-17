// Main/preload account boundaries with synthetic Electron objects. No network,
// actual sign-in, user profile, native dialog or real Notification is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createAccountService } = require('../account-service.js');

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const channels=['account:state','account:google','account:cancel','account:email-send','account:email-verify','account:connect','account:sync','account:sign-out','account:recovery','account:export-conflicts'];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fixtures=[];
function fixture(options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'planner-account-ipc-'));
  const rawHandlers={},rawListeners={},calls=[],windows=[],accountListeners=new Set();
  const paths={appData:dir,userData:dir};
  const app=new EventEmitter();Object.assign(app,{isPackaged:!!options.packaged,getVersion:()=> '0.1.2',getPath:name=>paths[name]||dir,setName:name=>calls.push(['set-name',name]),setPath:(name,value)=>{assert(fs.existsSync(value));paths[name]=value;calls.push(['set-path',name,value])},getAppPath:()=>'/synthetic-app',requestSingleInstanceLock:()=>{calls.push(['single-instance',paths.userData]);return true},setAppUserModelId:id=>calls.push(['app-id',id]),whenReady:()=>Promise.resolve(),setLoginItemSettings:value=>calls.push(['auto-start',value]),quit(){},exit:code=>calls.push(['exit',code])});
  const data={events:[],todos:[],projects:[],settings:{notifications:true}},authState={configured:false,authenticated:false,user:null,needsLogin:false,pending:false,error:''},syncState={configured:false,connected:false,pending:0,status:'unconfigured',user:null};
  let saved=data,flushAnswer=true,custom=false,backupFails=false,syncOptions,accountOptions,account;
  class Window{
    constructor(){this.destroyed=false;this.minimized=false;this.visible=false;this.focused=false;this.webContents={mainFrame:{},send:(channel,value)=>{calls.push(['send',channel,value]);if(channel==='app:flush-request')queueMicrotask(()=>rawListeners['app:flush-done']?.(trusted(),value,flushAnswer));},on(){},setWindowOpenHandler(){}};windows.push(this);}
    setMenuBarVisibility(){}loadFile(){}once(){}on(){}isDestroyed(){return this.destroyed}isMinimized(){return this.minimized}
    restore(){this.minimized=false;calls.push(['window-restore'])}show(){this.visible=true;calls.push(['window-show'])}hide(){this.visible=false}focus(){this.focused=true;calls.push(['window-focus'])}
  }
  const trusted=()=>({sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame});
  const store={load:()=>({data}),save:next=>{calls.push(['save']);saved=next},backupIfNeeded(){},backupNow:()=>{calls.push(['backup']);if(backupFails)throw Error('synthetic backup failure')},listBackups:()=>[],info:()=>({custom,dataDir:dir,backupDir:path.join(dir,'backups')}),inspectDir:()=>({ok:true,hasData:false}),useDir:(...args)=>{calls.push(['useDir',...args]);custom=true;return saved},restoreBackup:()=>saved,checkExternal:()=>null};
  const authMethods={
    signInGoogle:async()=>{calls.push(['google']);throw Object.assign(Error('SYNTHETIC-RAW-SECRET'),{code:'ACCOUNT_SETUP'})},
    cancelSignIn:()=>{calls.push(['cancel']);return {...authState}},
    sendEmailCode:async email=>{calls.push(['email-send',email]);throw Object.assign(Error('SYNTHETIC-RAW-SECRET'),{code:'ACCOUNT_SETUP'})},
    verifyEmailCode:async value=>{calls.push(['email-verify',value]);throw Object.assign(Error('SYNTHETIC-RAW-SECRET'),{code:'ACCOUNT_SETUP'})},
    signOut:async()=>{calls.push(['sign-out']);authState.authenticated=false;authState.user=null;return {...authState}},
    rpc:async(...args)=>{calls.push(['rpc',...args]);return []},
  };
  const syncMethods={connect:async value=>{calls.push(['connect',value])},syncNow:async()=>{calls.push(['sync'])},disconnect:async()=>{calls.push(['disconnect'])},resolveRecovery:async value=>{calls.push(['recovery',value])}};
  const sync={getState:()=>({...syncState}),start:()=>calls.push(['sync-start']),localSaved:()=>calls.push(['localSaved']),dispose:()=>calls.push(['sync-dispose']),...Object.fromEntries(Object.keys(syncMethods).map(name=>[name,(...args)=>syncMethods[name](...args)]))};
  class Notification{static isSupported(){return true}on(){}show(){calls.push(['notice'])}}
  const dialog={showMessageBox:async()=>({response:1}),showOpenDialog:async()=>{calls.push(['folder-dialog']);return options.openDialog?options.openDialog():{canceled:true,filePaths:[]}},showSaveDialog:async()=>{calls.push(['save-dialog']);return options.saveDialog?options.saveDialog():{canceled:true}}};
  const electron={app,BrowserWindow:Window,Notification,Tray:class{setToolTip(){}setContextMenu(){}on(){}},Menu:{buildFromTemplate:value=>value},nativeImage:{createFromPath:()=>({resize:()=>({})})},ipcMain:{handle:(name,fn)=>{rawHandlers[name]=fn},on:(name,fn)=>{rawListeners[name]=fn}},dialog,shell:{openPath:async()=>'',openExternal:async()=>{calls.push(['external-open'])}},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},powerMonitor:new EventEmitter()};
  const updater={getState:()=>({status:'unsupported'}),start(){},dispose(){},check:async()=>({}),install:async()=>({})};
  const sandbox={__dirname:path.join(__dirname,'..'),process:{platform:options.platform||'linux',argv:options.argv||[],env:{}},console:{error(){}},setTimeout,clearTimeout,setInterval:()=>({unref(){}}),
    require:name=>{
      if(name==='electron')return electron;
      if(name==='./package.json')return{...require('../package.json'),plannerAccountTest:options.testBuild===true,plannerTestTarget:'0.1.3'};
      if(name==='electron-updater'){calls.push(['updater-module']);throw Error('Test fixture must not load the live updater')}
      if(name==='./store.js')return{createStore:()=>store};
      if(name==='./updater.js')return{createUpdateController:()=>updater};
      if(name==='./reminders.js')return{createReminderScheduler:()=>({tick(){calls.push(['reminder-tick'])},dispose(){}})};
      if(name==='./account-service.js')return{createAccountService:value=>{
        accountOptions=value;
        if(options.realUnconfiguredAccount){account=createAccountService({...value,config:null,configFile:path.join(dir,'missing-config.json'),transport:async()=>{calls.push(['network']);throw Error('Unexpected synthetic transport')}});return account}
        account={getState:()=>({...authState,user:authState.user?{...authState.user}:null}),onState:cb=>{accountListeners.add(cb);return()=>accountListeners.delete(cb)},dispose(){},...Object.fromEntries(Object.keys(authMethods).map(name=>[name,(...args)=>authMethods[name](...args)]))};return account;
      }};
      if(name==='./sync-service.js')return{createSyncService:value=>{syncOptions=value;return sync}};
      return name.startsWith('./')?require('../'+name.slice(2)):require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),sandbox);
  const f={dir,calls,windows,rawHandlers,rawListeners,authState,syncState,authMethods,syncMethods,invoke:(name,...args)=>rawHandlers[name](trusted(),...args),trusted,getSyncOptions:()=>syncOptions,getAccountOptions:()=>accountOptions,getAccount:()=>account,emitAccountState:()=>{for(const cb of accountListeners)cb({...authState})},setCustom:value=>{custom=value},setBackupFails:value=>{backupFails=value},setFlushAnswer:value=>{flushAnswer=value},dispose:()=>{account?.dispose?.()}};fixtures.push(f);return f;
}
let passed=0,failed=0;
async function test(name,run){try{await run();passed++;console.log('PASS',name)}catch(error){failed++;console.error('FAIL',name,'\n',error.stack)}}
(async()=>{
  await test('Private test build creates a separate profile before its lock and skips startup/update APIs',async()=>{
    const f=fixture({testBuild:true,packaged:true,platform:'win32'});await tick();
    const isolated=path.join(f.dir,'my-planner-account-test');assert(fs.statSync(isolated).isDirectory());
    assert(f.calls.findIndex(c=>c[0]==='set-path')<f.calls.findIndex(c=>c[0]==='single-instance'));
    assert.equal(f.calls.find(c=>c[0]==='single-instance')[1],isolated);
    assert.equal(f.calls.find(c=>c[0]==='app-id')[1],'com.myplanner.app.accounttest');
    assert(!f.calls.some(c=>c[0]==='auto-start'||c[0]==='updater-module'));
    const info=f.invoke('app:build-info');assert.equal(info.accountTestBuild,true);assert.equal(info.autoStartAllowed,false);assert.equal(info.autoUpdateAllowed,false);assert.equal(info.targetVersion,'0.1.3');
    await f.invoke('data:save',{events:[],todos:[],projects:[],settings:{autoStart:true}});
    assert(!f.calls.some(c=>c[0]==='auto-start'));
    await assert.rejects(f.invoke('storage:chooseFolder'),/전용 저장 폴더/);
    await assert.rejects(f.invoke('storage:resetFolder'),/전용 저장 폴더/);
    assert.throws(()=>f.rawHandlers['app:build-info']({sender:{},senderFrame:{}}),/앱 화면/);
  });
  await test('Private test harness retains an explicit isolated user-data-dir',async()=>{
    const f=fixture({testBuild:true,argv:['--user-data-dir=/synthetic-isolated-profile']});await tick();
    assert(!f.calls.some(c=>c[0]==='set-path'));
    assert.equal(f.invoke('app:build-info').accountTestBuild,true);
    assert(!f.calls.some(c=>c[0]==='auto-start'));
  });
  await test('Every account IPC rejects foreign senders, child frames and destroyed windows before work',async()=>{
    const f=fixture();await tick();assert(channels.every(channel=>typeof f.rawHandlers[channel]==='function'));
    for(const channel of channels){
      const before=f.calls.length;
      for(const event of [{sender:{},senderFrame:f.windows[0].webContents.mainFrame},{sender:f.windows[0].webContents,senderFrame:{}},{}])assert.throws(()=>f.rawHandlers[channel](event,{}),/앱 화면/);
      assert.equal(f.calls.length,before,channel);
    }
    f.windows[0].destroyed=true;assert.throws(()=>f.rawHandlers['account:state'](f.trusted()),/앱 화면/);
  });
  await test('Unconfigured native account status and signup failure leave guest saving available',async()=>{
    const f=fixture({realUnconfiguredAccount:true});await tick();const status=f.invoke('account:state');assert.equal(status.auth.configured,false);assert.equal(status.sync.connected,false);
    await assert.rejects(f.invoke('account:google'),error=>error.message==='ACCOUNT_SETUP');await assert.rejects(f.invoke('account:email-send','test@example.invalid'),error=>error.message==='ACCOUNT_SETUP');
    const data={events:[{id:'synthetic-local'}],todos:[],projects:[],settings:{}};assert.equal(f.invoke('data:save',data),true);assert.deepEqual(f.invoke('data:load'),data);
    assert(!f.calls.some(call=>call[0]==='network'||call[0]==='external-open'));
  });
  await test('Account action failures expose fixed codes without raw service or server text',async()=>{
    const f=fixture();await tick();
    await assert.rejects(f.invoke('account:google'),error=>error.message==='ACCOUNT_SETUP'&&!error.message.includes('SECRET'));
    f.authMethods.signInGoogle=async()=>{throw Error('SYNTHETIC-SERVER-SECRET')};await assert.rejects(f.invoke('account:google'),error=>error.message==='ACCOUNT_FAILED');
    f.authMethods.signInGoogle=async()=>{throw Object.assign(Error('SYNTHETIC-SERVER-SECRET'),{code:'ACCOUNT_BAD;SYNTHETIC-SECRET'})};await assert.rejects(f.invoke('account:google'),error=>error.message==='ACCOUNT_FAILED');
  });
  await test('Completed Google sign-in restores and focuses the existing hidden or minimized app',async()=>{
    const f=fixture();await tick();const window=f.windows[0];
    assert.equal(typeof f.getAccountOptions().onGoogleSignInSuccess,'function');
    window.visible=false;window.minimized=true;const before=f.calls.length;
    f.getAccountOptions().onGoogleSignInSuccess();
    assert.equal(window.minimized,false);assert.equal(window.visible,true);assert.equal(window.focused,true);
    assert.deepEqual(f.calls.slice(before).map(call=>call[0]),['window-restore','window-show','window-focus']);
    assert.equal(f.windows.length,1);
  });
  await test('Ordinary account state changes and login failures never steal window focus',async()=>{
    const f=fixture();await tick();const window=f.windows[0];window.visible=false;window.minimized=true;
    for(const state of [
      {pending:true,authenticated:false,error:''},
      {pending:false,authenticated:false,error:'ACCOUNT_GOOGLE_CONFIG'},
      {pending:false,authenticated:false,error:'ACCOUNT_GOOGLE_CANCELLED'},
      {pending:false,authenticated:true,error:'',user:{id:A,email:'test@example.invalid'}},
    ]){Object.assign(f.authState,state);f.emitAccountState()}
    assert(f.calls.some(call=>call[0]==='send'&&call[1]==='account:state'));
    assert(!f.calls.some(call=>['window-restore','window-show','window-focus'].includes(call[0])));
    assert.equal(window.minimized,true);assert.equal(window.visible,false);assert.equal(window.focused,false);
  });
  await test('Connecting forwards only an explicit boolean import choice',async()=>{
    const f=fixture();await tick();await f.invoke('account:connect',{importLocal:'true',userId:B,access_token:'SYNTHETIC-SECRET'});await f.invoke('account:connect',{importLocal:true});
    const args=f.calls.filter(call=>call[0]==='connect').map(call=>call[1]);assert.equal(JSON.stringify(args),JSON.stringify([{importLocal:false},{importLocal:true}]));
  });
  await test('A custom storage folder blocks account connection before sync begins',async()=>{
    const f=fixture();await tick();f.setCustom(true);await assert.rejects(f.invoke('account:connect',{importLocal:true}),error=>error.message==='PLANNER_SYNC_FOLDER');assert(!f.calls.some(call=>call[0]==='connect'));
  });
  await test('Profile changes require renderer flush and backup before application',async()=>{
    const f=fixture();await tick();const before=f.calls.length;assert.equal(await f.getSyncOptions().beforeApply({reason:'profile'}),true);
    const order=f.calls.slice(before);assert(order.findIndex(call=>call[0]==='send'&&call[1]==='app:flush-request')<order.findIndex(call=>call[0]==='backup'));
    f.setFlushAnswer(false);const backups=f.calls.filter(call=>call[0]==='backup').length;assert.equal(await f.getSyncOptions().beforeApply({reason:'profile'}),false);assert.equal(f.calls.filter(call=>call[0]==='backup').length,backups);
    f.setFlushAnswer(true);f.setBackupFails(true);await assert.rejects(f.getSyncOptions().beforeApply({reason:'profile'}),/backup/);
  });
  await test('Sync disconnect must finish before credentials can be signed out',async()=>{
    const f=fixture();await tick();f.syncMethods.disconnect=async()=>{f.calls.push(['disconnect-start']);throw Object.assign(Error('SYNTHETIC-PRIVATE-DATA'),{code:'PLANNER_SYNC_STORAGE'})};
    await assert.rejects(f.invoke('account:sign-out'),error=>error.message==='PLANNER_SYNC_STORAGE');assert(!f.calls.some(call=>call[0]==='sign-out'));
    f.syncMethods.disconnect=async()=>{f.calls.push(['disconnect-done'])};await f.invoke('account:sign-out');assert(f.calls.findIndex(call=>call[0]==='disconnect-done')<f.calls.findIndex(call=>call[0]==='sign-out'));
  });
  await test('Interrupted-profile recovery requires an explicit keepAsGuest choice',async()=>{
    const f=fixture();await tick();await assert.rejects(f.invoke('account:recovery',{}),error=>error.message==='PLANNER_SYNC_RECOVERY');assert(!f.calls.some(call=>call[0]==='recovery'));
    await f.invoke('account:recovery',{keepAsGuest:true,accountId:B});assert.equal(JSON.stringify(f.calls.find(call=>call[0]==='recovery')[1]),JSON.stringify({keepAsGuest:true}));
  });
  await test('Connected account data cannot be moved into a custom sync folder',async()=>{
    const f=fixture();await tick();f.syncState.connected=true;
    await assert.rejects(f.invoke('storage:chooseFolder'),/계정 동기화/);await assert.rejects(f.invoke('storage:resetFolder'),/계정 동기화/);assert(!f.calls.some(call=>call[0]==='folder-dialog'||call[0]==='useDir'));
  });
  await test('Folder dialog rechecks an account connected while the picker was open',async()=>{
    const gate=deferred();const f=fixture({openDialog:()=>gate.promise});await tick();
    const operation=f.invoke('storage:chooseFolder').then(value=>({value}),error=>({error}));await tick();assert(f.calls.some(call=>call[0]==='folder-dialog'));
    f.syncState.connected=true;gate.resolve({canceled:false,filePaths:[path.join(f.dir,'synthetic-shared-folder')]});const result=await operation;
    assert(result.error||result.value?.error,'Folder selection must reject a newly connected account');assert(!f.calls.some(call=>call[0]==='useDir'));
  });
  await test('Profile-switch hook rejects a custom folder selected during a pending account connection',async()=>{
    const f=fixture();await tick();f.setCustom(true);await assert.rejects(f.getSyncOptions().beforeApply({reason:'profile',accountId:A}),error=>error.code==='PLANNER_SYNC_FOLDER');assert(!f.calls.some(call=>call[0]==='backup'));
  });
  await test('A guest-profile logout transition can still flush and back up a custom folder',async()=>{
    const f=fixture();await tick();f.setCustom(true);assert.equal(await f.getSyncOptions().beforeApply({reason:'profile',accountId:null}),true);assert(f.calls.some(call=>call[0]==='backup'));
  });
  await test('Conflict export requires matching connected identity before contacting server or showing a dialog',async()=>{
    const f=fixture();await tick();f.authState.authenticated=true;f.authState.user={id:A,email:'test@example.invalid'};f.syncState.connected=true;f.syncState.user={id:B};
    await assert.rejects(f.invoke('account:export-conflicts'),error=>error.message==='ACCOUNT_AUTH');assert(!f.calls.some(call=>call[0]==='rpc'||call[0]==='save-dialog'));
  });
  await test('Conflict export discards old-account results and native-dialog account changes',async()=>{
    const gate=deferred(),file=path.join(os.tmpdir(),'planner-synthetic-conflicts-'+Date.now()+'.json');
    const f=fixture({saveDialog:()=>gate.promise});await tick();f.authState.authenticated=true;f.authState.user={id:A,email:'test@example.invalid'};f.syncState.connected=true;f.syncState.user={id:A};
    f.authMethods.rpc=async()=>{f.authState.user={id:B,email:'other@example.invalid'};return[]};await assert.rejects(f.invoke('account:export-conflicts'),error=>error.message==='ACCOUNT_CANCELLED');assert(!f.calls.some(call=>call[0]==='save-dialog'));
    f.authState.user={id:A,email:'test@example.invalid'};f.authMethods.rpc=async()=>[];const operation=f.invoke('account:export-conflicts').then(value=>({value}),error=>({error}));await tick();assert(f.calls.some(call=>call[0]==='save-dialog'));
    f.authState.user={id:B,email:'other@example.invalid'};gate.resolve({canceled:false,filePath:file});assert.equal((await operation).error?.message,'ACCOUNT_CANCELLED');assert(!fs.existsSync(file));
  });
  await test('Preload exposes fixed account operations without tokens, arbitrary RPC, URL or config setters',()=>{
    const exposed={},invocations=[],listeners=new Map();
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8'),{require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api}},ipcRenderer:{invoke:(...args)=>{invocations.push(args);return Promise.resolve({})},on:(name,fn)=>{listeners.set(name,fn)},removeListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name)},send(){}}}}});
    const api=exposed.plannerAccount;assert(api);assert.deepEqual(Object.keys(api).sort(),['getState','signInGoogle','cancelSignIn','sendEmailCode','verifyEmailCode','connect','syncNow','signOut','resolveRecovery','exportConflicts','onState'].sort());
    for(const name of ['getToken','getAccessToken','getRefreshToken','rpc','fetch','setConfig','openExternal'])assert.equal(api[name],undefined);
    api.sendEmailCode('test@example.invalid');api.verifyEmailCode({code:'123456'});api.connect({importLocal:true});api.syncNow();assert.deepEqual(invocations.map(call=>call[0]),['account:email-send','account:email-verify','account:connect','account:sync']);
    let seen;const unsubscribe=api.onState(value=>{seen=value});const payload={auth:{authenticated:false},sync:{status:'guest'}};listeners.get('account:state')({syntheticSecretEvent:true},payload);assert.equal(seen,payload);unsubscribe();assert(!listeners.has('account:state'));
  });
})().catch(error=>{failed++;console.error(error.stack)}).finally(()=>{
  for(const f of fixtures){try{f.dispose()}catch{}try{fs.rmSync(f.dir,{recursive:true,force:true})}catch{}}
  console.log(`${passed} account IPC checks passed; ${failed} failed; fake Electron only`);if(failed)process.exitCode=1;
});
