// 저장 실패·응답 없음으로 업데이트 설치를 진행하지 않습니다. 통신과 설치 프로그램은 격리합니다.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../updater');
const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeUpdater extends EventEmitter {
  constructor() { super(); this.calls = 0; this.run = async () => { this.emit('update-not-available'); return {}; }; }
  checkForUpdates() { this.calls++; return this.run(); }
}
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }
function fixture(options = {}) {
  const updater = new FakeUpdater(), calls = [];
  const controller = createUpdateController({ updater, currentVersion: '0.1.1', prepareInstall: async () => { calls.push('saved'); return ''; }, performInstall: () => calls.push('install'), installFailed: () => calls.push('rollback'), notify: s => calls.push(s.status), ...options });
  return { updater, calls, controller };
}
(async () => {
  await test('개발/Store 등 미지원 환경은 확인·설치를 실행하지 않음', async () => {
    const f=fixture({updater:null,disabledReason:'store'}); f.controller.start(); await f.controller.check(); await f.controller.install(); assert.equal(f.controller.getState().status,'unsupported'); assert.deepEqual(f.calls,[]); f.controller.dispose();
  });
  await test('일반 종료 설치·다운그레이드·prerelease는 비활성, 다운로드만 자동', () => {
    const f=fixture(); assert(f.updater.autoDownload); assert.equal(f.updater.autoInstallOnAppQuit,false); assert.equal(f.updater.allowDowngrade,false); assert.equal(f.updater.allowPrerelease,false); f.controller.dispose();
  });
  await test('확인 중 중복 요청은 한 번만 전송', async () => {
    const f=fixture(); let done; f.updater.run=()=>new Promise(r=>{done=r}); const first=f.controller.check(); await f.controller.check(); assert.equal(f.updater.calls,1); done({}); await first; f.controller.dispose();
  });
  await test('확인 실패 후 앱 상태 유지·재시도 가능, 오류 원문/경로 노출 없음', async () => {
    const f=fixture(); f.updater.run=async()=>{throw Error('private test path')}; await f.controller.check(); assert.equal(f.controller.getState().status,'error'); assert(!JSON.stringify(f.controller.getState()).includes('private')); f.updater.run=async()=>{f.updater.emit('update-not-available');return {}};await f.controller.check();assert.equal(f.controller.getState().status,'up-to-date');f.controller.dispose();
  });
  await test('다운로드 Promise 실패도 처리하고 재시도 가능', async () => {
    const f=fixture(); f.updater.run=async()=>({downloadPromise:Promise.reject(Error('bad hash'))});await f.controller.check();await tick();assert.equal(f.controller.getState().status,'error'); f.controller.dispose();
  });
  await test('새 버전 다운로드 완료만으로 설치하지 않음', async () => {
    const f=fixture();f.updater.emit('update-available',{version:'0.1.2'});f.updater.emit('download-progress',{percent:55});assert.equal(f.controller.getState().percent,55);f.updater.emit('update-downloaded',{version:'0.1.2'});await f.controller.check();assert.equal(f.controller.getState().status,'ready');assert(!f.calls.includes('install'));assert.equal(f.updater.calls,0);f.controller.dispose();
  });
  for(const blocked of ['save','backup','busy',null,false,undefined]) await test('저장/백업 확인이 불완전하면 설치하지 않음: '+String(blocked),async()=>{
    const f=fixture({prepareInstall:async()=>blocked});f.updater.emit('update-downloaded',{version:'0.1.2'});await f.controller.install();assert.equal(f.controller.getState().status,'ready');assert(!f.calls.includes('install'));f.controller.dispose();
  });
  await test('저장 확인을 기다린 후 한 번만 설치, 동시에 누르면 중복 없음',async()=>{
    let done;const f=fixture({prepareInstall:()=>new Promise(r=>{done=r})});f.updater.emit('update-downloaded',{version:'0.1.2'});const pending=f.controller.install();await f.controller.install();assert(!f.calls.includes('install'));done('');await pending;assert.deepEqual(f.calls.filter(x=>x==='install'),['install']);f.controller.dispose();
  });
  await test('설치 시작 실패는 종료 상태를 되돌리고 재시도 허용',async()=>{
    const f=fixture({performInstall:()=>{throw Error('cannot spawn')}});f.updater.emit('update-downloaded',{version:'0.1.2'});await f.controller.install();assert.equal(f.controller.getState().status,'ready');assert.equal(f.controller.getState().issue,'install');assert(f.calls.includes('rollback'));f.controller.dispose();
  });
  await test('늦게 도착한 설치 오류·종료 후 오류도 미처리 예외를 만들지 않음',async()=>{
    const f=fixture();f.updater.emit('update-downloaded',{version:'0.1.2'});await f.controller.install();f.updater.emit('error',Error('spawn'));assert.equal(f.controller.getState().issue,'install');f.controller.dispose();const state=f.controller.getState();f.updater.emit('error',Error('late'));assert.deepEqual(f.controller.getState(),state);
  });

  // 실제 main.js의 종료·백업·before-quit 연결도 VM에서 검증합니다.
  const fs = require('node:fs'), path=require('node:path'), vm=require('node:vm');
  function mainFixture() {
    const handlers={}, events={}, timers=[], calls=[], fakeUpdater=new FakeUpdater();let backupFails=false;
    const app={isPackaged:true,getVersion:()=> '0.1.1',getPath:()=>'/isolated',getAppPath:()=>'/app',requestSingleInstanceLock:()=>true,setAppUserModelId(){},whenReady:()=>Promise.resolve(),on:(n,f)=>events[n]=f,setLoginItemSettings(){},quit:()=>calls.push('quit')};
    class Window { constructor(){this.webContents={send:(ch,id)=>calls.push({ch,id})};} setMenuBarVisibility(){} loadFile(){} once(){} on(){} isDestroyed(){return false} isMinimized(){return false} show(){} focus(){} }
    class Tray{setToolTip(){}setContextMenu(){}on(){}}
    const electron={app,BrowserWindow:Window,ipcMain:{handle:(k,f)=>handlers[k]=f,on:(k,f)=>handlers[k]=f},Notification:{isSupported:()=>false},Tray,Menu:{buildFromTemplate:x=>x},nativeImage:{createFromPath:()=>({resize:()=>({})})},dialog:{},shell:{}};
    fakeUpdater.quitAndInstall=(silent,restart)=>{calls.push({install:[silent,restart]});let prevented=false;events['before-quit']({preventDefault:()=>{prevented=true}});calls.push({prevented});};
    const store={load:()=>({data:{events:[],todos:[],projects:[],settings:{}}}),backupIfNeeded(){},backupNow:()=>{calls.push('backup');if(backupFails)throw Error('read-only')},checkExternal:()=>null};
    const sandbox={process:{platform:'win32',argv:[]},__dirname:path.join(__dirname,'..'),console,require:r=>r==='electron'?electron:r==='electron-updater'?{autoUpdater:fakeUpdater}:r==='./store.js'?{createStore:()=>store}:r==='./renderer/recurrence.js'?{occurrencesInRange:()=>[]}:r==='./updater.js'?{createUpdateController}:require(r),setInterval:()=>({unref(){}}),setTimeout:(fn,ms)=>{const t={fn,ms,unref(){}};timers.push(t);return t},clearTimeout(){}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),sandbox);
    return {handlers,events,timers,calls,updater:fakeUpdater,setBackupFailure:()=>{backupFails=true},ready:async()=>{await tick();fakeUpdater.emit('update-downloaded',{version:'0.1.2'})}};
  }
  await test('실제 main: 저장 실패와 응답 없음은 설치·종료를 차단',async()=>{
    for(const answer of [false,null]){const f=mainFixture();await f.ready();const pending=f.handlers['updates:install']();await tick();const request=f.calls.find(x=>x.ch==='app:flush-request');assert(request);if(answer===null)f.timers.find(t=>t.ms===2000).fn();else f.handlers['app:flush-done'](null,request.id,answer);await pending;assert(!f.calls.some(x=>x.install||x==='quit'||x==='backup'));assert.equal(f.handlers['updates:state']().issue,'save');}
  });
  await test('실제 main: 백업 실패도 설치를 차단',async()=>{
    const f=mainFixture();await f.ready();f.setBackupFailure();const p=f.handlers['updates:install']();await tick();const r=f.calls.find(x=>x.ch==='app:flush-request');f.handlers['app:flush-done'](null,r.id,true);await p;assert(f.calls.includes('backup'));assert(!f.calls.some(x=>x.install));assert.equal(f.handlers['updates:state']().issue,'backup');
  });
  await test('실제 main: 저장 응답 → 로컬 백업 → 설치/재실행, 재차 저장 대기로 막지 않음',async()=>{
    const f=mainFixture();await f.ready();const p=f.handlers['updates:install']();await tick();assert(!f.calls.includes('backup'));const r=f.calls.find(x=>x.ch==='app:flush-request');f.handlers['app:flush-done'](null,r.id,true);await p;assert(f.calls.indexOf('backup')<f.calls.findIndex(x=>x.install));assert.deepEqual(f.calls.find(x=>x.install).install,[true,true]);assert.equal(f.calls.find(x=>Object.hasOwn(x,'prevented')).prevented,false);
  });
  console.log(passed+' updater checks passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1});
