// Diagnostic only: real Windows foreground/z-order measurements on a disposable
// hosted runner. This does not assert a product fix or perform a live sign-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

assert(process.platform === 'win32' && process.env.CI === 'true' && process.env.RUNNER_OS === 'Windows', 'Run only on a disposable Windows CI runner');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-windows-return-'));
const marker = path.join(owned, 'owned-test.marker');
fs.writeFileSync(marker, 'Disposable synthetic Windows app-return diagnostic');
const profile = path.join(owned, 'profile'); fs.mkdirSync(profile);
const executable = process.env.PLANNER_EXECUTABLE || require('electron');
const packaged = !!process.env.PLANNER_EXECUTABLE;
const report = {
  diagnostic: true, platform: process.platform, packaged,
  provider: 'Synthetic PKCE response; shell browser opening captured in memory; no live Google',
  status: 'running', conclusions: [], states: [], errors: [], networkCalls: 0,
  note: 'Foreground ownership and z-order are separate. Conclusive execution is not proof of a product fix.',
};
let running, page, fixture, fixturePid;
const fixtureState = path.join(owned, 'fixture-state.json');
const fixtureCommand = path.join(owned, 'fixture-command.json');
let sequence = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeMessage = error => String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL omitted]').slice(0, 1800);
const inconclusive = reason => Object.assign(new Error(reason), { inconclusive: true });
async function until(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(80); }
  throw inconclusive(label);
}
const nativeCode = String.raw`
using System;
using System.Runtime.InteropServices;
public static class PlannerNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint n);
 [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int n);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool LockSetForegroundWindow(uint code);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
 public static uint LastInput() { LASTINPUTINFO x = new LASTINPUTINFO(); x.cbSize = (uint)Marshal.SizeOf(x); return GetLastInputInfo(ref x) ? x.dwTime : 0; }
 public static bool Above(IntPtr a, IntPtr b) { if(a==IntPtr.Zero || b==IntPtr.Zero || a==b) return false; IntPtr h=GetWindow(b,3); for(int i=0;i<2048 && h!=IntPtr.Zero;i++,h=GetWindow(h,3)) if(h==a) return true; return false; }
 public static uint Owner(IntPtr h) { uint p=0; if(h!=IntPtr.Zero) GetWindowThreadProcessId(h,out p); return p; }
}
`;
const nativeFile = path.join(owned, 'native.cs'); fs.writeFileSync(nativeFile, nativeCode);
const probeFile = path.join(owned, 'probe.ps1');
fs.writeFileSync(probeFile, String.raw`
param([string]$Native,[string]$Planner='0',[string]$External='0')
$ErrorActionPreference='Stop'
Add-Type -Path $Native
$a=[IntPtr]([long]::Parse($Planner));$b=[IntPtr]([long]::Parse($External))
$f=[PlannerNative]::GetForegroundWindow();$d=[PlannerNative]::OpenInputDesktop(0,$false,1)
$inputDesktop=$d -ne [IntPtr]::Zero
if($inputDesktop){[void][PlannerNative]::CloseDesktop($d)}
@{ session=[Diagnostics.Process]::GetCurrentProcess().SessionId;inputDesktop=$inputDesktop;foregroundPid=[PlannerNative]::Owner($f);plannerPid=[PlannerNative]::Owner($a);externalPid=[PlannerNative]::Owner($b);plannerForeground=($a -ne [IntPtr]::Zero -and $f -eq $a);externalForeground=($b -ne [IntPtr]::Zero -and $f -eq $b);plannerVisible=[PlannerNative]::IsWindowVisible($a);plannerMinimized=[PlannerNative]::IsIconic($a);plannerAboveExternal=[PlannerNative]::Above($a,$b);plannerTopmost=(([PlannerNative]::GetWindowLongPtr($a,-20).ToInt64() -band 8) -ne 0);externalTopmost=(([PlannerNative]::GetWindowLongPtr($b,-20).ToInt64() -band 8) -ne 0);lastInput=[PlannerNative]::LastInput() } | ConvertTo-Json -Compress
`);
const formFile = path.join(owned, 'foreign-window.ps1');
fs.writeFileSync(formFile, String.raw`
param([string]$Native,[string]$State,[string]$CommandPath)
$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Owned Windows CI fixture only'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path $Native
$form=New-Object Windows.Forms.Form
$form.Text='Synthetic external login window - MyPlanner diagnostic'
$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(20,20);$form.Size=New-Object Drawing.Size(1100,780)
$form.BackColor=[Drawing.Color]::FromArgb(235,235,235)
$label=New-Object Windows.Forms.Label;$label.Dock='Fill';$label.TextAlign='MiddleCenter';$label.Text='Synthetic external login window. No Google or personal data.';$form.Controls.Add($label)
$cursor=New-Object PlannerNative+POINT;[void][PlannerNative]::GetCursorPos([ref]$cursor)
$script:last=0;$script:pending=$null;$script:due=[DateTime]::UtcNow
function Save-State($value){[IO.File]::WriteAllText($State,($value | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}
$timer=New-Object Windows.Forms.Timer;$timer.Interval=80
$timer.Add_Tick({
 try {
  if($script:pending -and [DateTime]::UtcNow -ge $script:due){
   $own=[PlannerNative]::GetForegroundWindow() -eq $form.Handle
   if($own -or [DateTime]::UtcNow -gt $script:pending.deadline){
    $form.TopMost=$false
    $locked=$false;if($own){$locked=[PlannerNative]::LockSetForegroundWindow(1)}
    Save-State @{id=$script:pending.id;ready=$true;pid=$PID;hwnd=$form.Handle.ToInt64().ToString();foreground=$own;locked=$locked;lastInput=[PlannerNative]::LastInput()}
    $script:pending=$null
   }
  }
  if(!(Test-Path -LiteralPath $CommandPath)){return}
  $c=[IO.File]::ReadAllText($CommandPath) | ConvertFrom-Json
  if([int]$c.id -le $script:last){return};$script:last=[int]$c.id
  if($c.action -eq 'lock'){
   [void][PlannerNative]::LockSetForegroundWindow(2)
   $form.Show();$form.TopMost=$true;$form.Activate();[void][PlannerNative]::SetForegroundWindow($form.Handle)
   # Real input is restricted to this owned disposable fixture. No ALT or policy changes.
   [void][PlannerNative]::SetCursorPos($form.Left+($form.Width/2),$form.Top+($form.Height/2))
   [PlannerNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[PlannerNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
   $script:pending=@{id=[int]$c.id;deadline=[DateTime]::UtcNow.AddSeconds(4)};$script:due=[DateTime]::UtcNow.AddMilliseconds(250)
  }elseif($c.action -eq 'unlock'){
   [void][PlannerNative]::LockSetForegroundWindow(2);Save-State @{id=[int]$c.id;ready=$true;unlocked=$true;pid=$PID;hwnd=$form.Handle.ToInt64().ToString()}
  }elseif($c.action -eq 'stop'){
   [void][PlannerNative]::LockSetForegroundWindow(2);Save-State @{id=[int]$c.id;ready=$true;stopped=$true};$form.Close()
  }else{throw 'Unknown fixture command'}
 }catch{Save-State @{id=$script:last;error='Foreign fixture failed';type=$_.Exception.GetType().Name};$form.Close()}
})
$form.Add_Shown({Save-State @{id=0;ready=$true;pid=$PID;hwnd=$form.Handle.ToInt64().ToString()};$timer.Start()})
try{[Windows.Forms.Application]::Run($form)}finally{[void][PlannerNative]::LockSetForegroundWindow(2);$timer.Stop();$timer.Dispose();$form.Dispose();[void][PlannerNative]::SetCursorPos($cursor.X,$cursor.Y)}
`);
function probe(planner='0', external='0') {
  const text = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',probeFile,'-Native',nativeFile,'-Planner',planner,'-External',external], { encoding:'utf8', windowsHide:true, timeout:12000 });
  return JSON.parse(text.trim());
}
function readFixture() { try { return JSON.parse(fs.readFileSync(fixtureState,'utf8')); } catch { return null; } }
async function command(action) {
  const id=++sequence, temp=fixtureCommand+'.tmp';fs.writeFileSync(temp,JSON.stringify({id,action}));
  for(let attempt=0;;attempt++){try{fs.renameSync(temp,fixtureCommand);break}catch(error){if(attempt>=8)throw error;await pause(30)}}
  return until(()=>{const s=readFixture();if(s?.error)throw new Error(s.error+': '+s.type);return s?.id===id?s:null},'Owned foreground fixture did not answer '+action,12000);
}
function callbackRequest(url) {
  return new Promise((resolve,reject)=>{
    const req=http.get(url,{agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
    req.setTimeout(12000,()=>req.destroy(new Error('Synthetic callback timeout')));req.on('error',reject);
  });
}
function observation(s) {
  return {foregroundPlanner:s.plannerForeground,foregroundExternal:s.externalForeground,visible:s.plannerVisible,minimized:s.plannerMinimized,aboveExternal:s.plannerAboveExternal,topmost:s.plannerTopmost,lastInput:s.lastInput};
}
let plannerHandle,plannerPid,externalHandle;
async function plannerState(mode) {
  await running.evaluate(({BrowserWindow},mode)=>{const w=BrowserWindow.getAllWindows()[0];if(w.isMinimized())w.restore();w.show();if(mode==='hidden')w.hide();if(mode==='minimized')w.minimize()},mode);
}
async function foreignLock() {
  const state=await command('lock');
  if(!state.foreground||!state.locked)throw inconclusive('Foreign fixture could not establish and lock native foreground');
  const native=probe(plannerHandle,externalHandle);
  const checks={externalForeground:native.externalForeground,externalOwnerMatches:native.externalPid===fixturePid,plannerOwnerMatches:native.plannerPid===plannerPid,externalNotTopmost:!native.externalTopmost,inputUnchanged:native.lastInput===state.lastInput};
  report.preconditions??=[];report.preconditions.push(checks);
  if(Object.values(checks).some(passed=>!passed))throw inconclusive('Foreign foreground/input precondition was not stable: '+JSON.stringify(checks));
  return native;
}
(async()=>{
  const environment=probe();report.desktop={session:environment.session,inputDesktop:environment.inputDesktop};
  if(!environment.inputDesktop||environment.session===0)throw inconclusive('No interactive native input desktop in this runner session');
  running=await _electron.launch({executablePath:executable,cwd:root,args:[...(packaged?[]:['.']),'--user-data-dir='+profile],env:{...process.env,CI:'true',PLANNER_DISABLE_AUTO_UPDATE:'1'},timeout:30000});
  const actual=await running.evaluate(({app})=>app.getPath('userData'));
  assert.equal(path.resolve(actual).toLowerCase(),path.resolve(profile).toLowerCase(),'Refusing to touch a non-owned app profile');
  // Playwright launches Electron through cmd.exe on Windows. Its child-process
  // PID can belong to that wrapper; the HWND owner must match Electron itself.
  plannerPid=await running.evaluate(()=>process.pid);
  page=await running.firstWindow();await page.waitForFunction(()=>window.storage&&window.plannerAccount&&document.querySelector('#homeBody')?.children.length);
  const initial=await page.evaluate(()=>window.storage.load());assert.equal(initial.todos.length,0);assert.equal(initial.events.length,0);
  plannerHandle=await running.evaluate(({BrowserWindow})=>{const b=BrowserWindow.getAllWindows()[0].getNativeWindowHandle();return (b.length===8?b.readBigUInt64LE():BigInt(b.readUInt32LE())).toString()});
  const availability=await running.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable());
  if(!availability)throw inconclusive('Windows credential encryption unavailable for the synthetic session');
  await running.evaluate(({shell,session})=>{
    globalThis.__returnDiagnostic={callback:null,networkCalls:0,unexpected:0};
    shell.openExternal=async value=>{const u=new URL(value);if(u.pathname!=='/auth/v1/authorize'||u.searchParams.get('provider')!=='google')throw Error('Unexpected synthetic browser request');globalThis.__returnDiagnostic.callback=u.searchParams.get('redirect_to')};
    globalThis.fetch=async(value,options={})=>{globalThis.__returnDiagnostic.networkCalls++;let u,body;
      try{u=new URL(value);body=JSON.parse(options.body)}catch{globalThis.__returnDiagnostic.unexpected++;throw Error('Blocked malformed network request')}
      if(u.pathname!=='/auth/v1/token'||u.searchParams.get('grant_type')!=='pkce'||body.auth_code!=='SYNTHETIC_WINDOWS_RETURN_CODE'){globalThis.__returnDiagnostic.unexpected++;throw Error('Blocked unexpected network request')}
      return new Response(JSON.stringify({access_token:'SYNTHETIC_WINDOWS_RETURN_ACCESS',refresh_token:'SYNTHETIC_WINDOWS_RETURN_REFRESH',expires_in:3600,user:{id:'11111111-1111-4111-8111-111111111111',email:'windows-return@example.invalid'}}),{status:200,headers:{'Content-Type':'application/json'}})};
    session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_details,cb)=>{globalThis.__returnDiagnostic.unexpected++;cb({cancel:true})});
  });
  fixture=spawn('powershell.exe',['-STA','-NoProfile','-NonInteractive','-File',formFile,'-Native',nativeFile,'-State',fixtureState,'-CommandPath',fixtureCommand],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  fixturePid=fixture.pid;
  const ready=await until(()=>{const s=readFixture();return s?.ready?s:null},'Synthetic foreign window did not start',15000);externalHandle=ready.hwnd;
  assert.equal(ready.pid,fixturePid);assert.notEqual(fixturePid,running.process().pid);
  for(const mode of ['normal','hidden','minimized']){
    await page.evaluate(()=>window.plannerAccount.signInGoogle());
    const raw=await running.evaluate(()=>globalThis.__returnDiagnostic.callback);assert(raw);
    const callback=new URL(raw);callback.searchParams.set('code','SYNTHETIC_WINDOWS_RETURN_CODE');
    await plannerState(mode);
    const before=await foreignLock();
    const status=await callbackRequest(callback.href);assert.equal(status,200);
    const baselineNow=probe(plannerHandle,externalHandle);await pause(350);const baselineSettled=probe(plannerHandle,externalHandle);
    assert.equal((await page.evaluate(()=>window.plannerAccount.getState())).auth.authenticated,true);
    await command('unlock');await plannerState(mode);const candidateBefore=await foreignLock();
    await running.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];if(w.isMinimized())w.restore();w.show();w.focus();w.moveTop()});
    const candidateNow=probe(plannerHandle,externalHandle);await pause(350);const candidateSettled=probe(plannerHandle,externalHandle);
    report.states.push({mode,precondition:{externalForeground:before.externalForeground,lock:true},baseline:{immediate:observation(baselineNow),settled:observation(baselineSettled),inputUnchanged:baselineSettled.lastInput===before.lastInput},candidate:{operations:'restore/show/focus/moveTop; real Electron APIs, no product patch',immediate:observation(candidateNow),settled:observation(candidateSettled),inputUnchanged:candidateSettled.lastInput===candidateBefore.lastInput}});
    if(baselineSettled.lastInput!==before.lastInput||candidateSettled.lastInput!==candidateBefore.lastInput)throw inconclusive('Native user input changed during an observation');
    assert.equal(candidateSettled.plannerTopmost,false,'Candidate left product permanently topmost');
    await command('unlock');
  }
  const transport=await running.evaluate(()=>({calls:globalThis.__returnDiagnostic.networkCalls,unexpected:globalThis.__returnDiagnostic.unexpected}));
  report.networkCalls=transport.calls;report.unexpectedNetworkCalls=transport.unexpected;assert.equal(transport.calls,3);assert.equal(transport.unexpected,0);
  report.status='conclusive-observation';
  report.conclusions.push('Actual Windows measurements completed under a verified foreign-process foreground lock.');
  report.conclusions.push('Candidate visibility, z-order and keyboard foreground must be read independently; no automatic-focus guarantee is inferred.');
})().catch(error=>{
  report.status=error.inconclusive?'inconclusive':'error';report.errors.push({kind:error.name,message:safeMessage(error)});
  if(!error.inconclusive)process.exitCode=1;
}).finally(async()=>{
  if(fixture){
    try{await command('stop')}catch{}
    const exited=()=>fixture.exitCode!==null||fixture.signalCode!==null;
    const waitExit=async timeout=>{
      if(exited())return;
      await new Promise(resolve=>{
        const done=()=>{clearTimeout(timer);fixture.removeListener('exit',done);resolve()};
        const timer=setTimeout(done,timeout);fixture.once('exit',done);
      });
    };
    await waitExit(2500);
    if(!exited()){fixture.kill();await waitExit(2500)}
    report.fixtureExited=exited();
    if(!report.fixtureExited){report.errors.push({message:'Owned foreground fixture did not exit after cleanup'});process.exitCode=1}
  }
  if(running)try{const done=running.waitForEvent('close',{timeout:10000});await running.evaluate(({app})=>app.quit()).catch(()=>{});await done}catch{try{await running.close()}catch{}}
  try{if(fs.existsSync(marker))fs.rmSync(owned,{recursive:true,force:true,maxRetries:8,retryDelay:100});report.cleanup='removed'}catch(error){report.cleanup={error:safeMessage(error)};process.exitCode=1}
  fs.writeFileSync(path.join(output,'windows-google-return.json'),JSON.stringify(report,null,2)+'\n');
  const compact={status:report.status,packaged:report.packaged,desktop:report.desktop,states:report.states.map(s=>({mode:s.mode,baseline:s.baseline.settled,candidate:s.candidate.settled})),errors:report.errors,unexpectedNetworkCalls:report.unexpectedNetworkCalls};
  const notice=JSON.stringify(compact).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
  console.log('::notice title=Windows OAuth return diagnostic::'+notice);
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### Windows OAuth return diagnostic\n\n```json\n'+JSON.stringify(compact,null,2)+'\n```\n\nA conclusive observation is not a claim that real Edge or user-PC focus is fixed.\n');
});
