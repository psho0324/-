// Diagnostic only: real Windows foreground/z-order measurements on a disposable
// hosted runner. This does not assert a product fix or perform a live sign-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { _electron, chromium } = require('playwright');

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
  runtime: { osRelease: os.release(), arch: process.arch },
  provider: 'Synthetic PKCE response; shell browser opening captured in memory; no live Google',
  status: 'running', conclusions: [], states: [], errors: [], networkCalls: 0,
  note: 'Foreground ownership and z-order are separate. Conclusive execution is not proof of a product fix.',
};
let running, page, fixture, fixturePid, edgeContext, edgeServer, protocolRegistration;
const fixtureState = path.join(owned, 'fixture-state.json');
const fixtureCommand = path.join(owned, 'fixture-command.json');
let sequence = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeMessage = error => String(error?.message || error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL omitted]').slice(0, 1800);
const inconclusive = reason => Object.assign(new Error(reason), { inconclusive: true });
async function bounded(promise, milliseconds, fallback) {
  let timer;
  try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),milliseconds)})])}
  finally{clearTimeout(timer)}
}
function publicSummary(value) {
  const shortError=items=>items?.[0]?safeMessage(items[0]).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,120):undefined;
  const edge=value.edge||{};
  const modes=(edge.attempts||[]).slice(0,3).map(attempt=>{
    const state=edge.states?.find(item=>item.mode===attempt.mode);
    const protocol=state?.protocol;
    const dialog=protocol?.confirmation||protocol?.initialPrompt;
    return{mode:attempt.mode,http:attempt.callbackHttpStatus,fresh:attempt.freshCapture,request:attempt.callbackRequestMatched,
      pkce:attempt.pkceAdvanced,pending:attempt.pendingAfter,nav:attempt.navigationError,clean:attempt.urlCleaned,currentFg:state?.currentProduct?.settled?.foregroundPlanner,
      protocol:protocol?{outcome:protocol.status,foreground:protocol.settled?.foregroundPlanner,singleWindow:protocol.singleWindow,topmost:protocol.settled?.topmost,
        auto:protocol.automaticRequests,explicit:protocol.explicitRequests,closed:protocol.callbackClosed,
        prompt:{matched:dialog?.present,acted:dialog?.acted,app:dialog?.permissionAppMatched,text:dialog?.permissionTextMatched,subtree:dialog?.permissionSubtreeMatched,buttons:dialog?.knownButtons?.slice(0,2)},
        error:shortError(protocol.errors)}:undefined};
  });
  return{status:value.status,packaged:value.packaged,runtime:value.runtime,desktop:value.desktop,
    locked:(value.states||[]).slice(0,3).map(state=>({mode:state.mode,baselineFg:state.baseline.settled.foregroundPlanner,candidateFg:state.candidate.settled.foregroundPlanner})),
    edge:{status:edge.status,version:edge.version,chromiumVersion:edge.chromiumVersion,protocolEnabled:edge.protocolEnabled,modes,error:shortError(edge.errors)},
    installedReturnVerified:value.installedReturnVerified===true,
    cleanup:{protocol:edge.protocolRegistrationCleaned,browser:edge.browserCleanup,temp:value.cleanup==='removed',fixture:value.fixtureExited},
    error:shortError(value.errors),unexpectedNetworkCalls:value.unexpectedNetworkCalls};
}
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
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr l);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int count);
 [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
 public static uint LastInput() { LASTINPUTINFO x = new LASTINPUTINFO(); x.cbSize = (uint)Marshal.SizeOf(x); return GetLastInputInfo(ref x) ? x.dwTime : 0; }
 public static bool Above(IntPtr a, IntPtr b) { if(a==IntPtr.Zero || b==IntPtr.Zero || a==b) return false; IntPtr h=GetWindow(b,3); for(int i=0;i<2048 && h!=IntPtr.Zero;i++,h=GetWindow(h,3)) if(h==a) return true; return false; }
 public static uint Owner(IntPtr h) { uint p=0; if(h!=IntPtr.Zero) GetWindowThreadProcessId(h,out p); return p; }
 public static bool BrowserFrame(IntPtr h) { var name=new System.Text.StringBuilder(128); GetClassName(h,name,name.Capacity); return name.ToString()=="Chrome_WidgetWin_1"; }
 public static IntPtr BrowserWindow(uint process) { IntPtr found=IntPtr.Zero; EnumWindows(delegate(IntPtr h,IntPtr l) { if(Owner(h)==process && IsWindowVisible(h) && BrowserFrame(h)) {found=h;return false;} return true; },IntPtr.Zero); return found; }
}
`;
const nativeFile = path.join(owned, 'native.cs'); fs.writeFileSync(nativeFile, nativeCode);
const probeFile = path.join(owned, 'probe.ps1');
fs.writeFileSync(probeFile, String.raw`
param([string]$Native,[string]$Planner='0',[string]$External='0',[string]$BrowserOwner='0')
$ErrorActionPreference='Stop'
Add-Type -Path $Native
$a=[IntPtr]([long]::Parse($Planner));$b=[IntPtr]([long]::Parse($External))
if($BrowserOwner -ne '0'){$b=[PlannerNative]::BrowserWindow([uint32]::Parse($BrowserOwner))}
$f=[PlannerNative]::GetForegroundWindow();$d=[PlannerNative]::OpenInputDesktop(0,$false,1)
$inputDesktop=$d -ne [IntPtr]::Zero
if($inputDesktop){[void][PlannerNative]::CloseDesktop($d)}
@{ session=[Diagnostics.Process]::GetCurrentProcess().SessionId;inputDesktop=$inputDesktop;foregroundPid=[PlannerNative]::Owner($f);plannerPid=[PlannerNative]::Owner($a);externalPid=[PlannerNative]::Owner($b);externalHandle=$b.ToInt64().ToString();plannerForeground=($a -ne [IntPtr]::Zero -and $f -eq $a);externalForeground=($b -ne [IntPtr]::Zero -and $f -eq $b);plannerVisible=[PlannerNative]::IsWindowVisible($a);plannerMinimized=[PlannerNative]::IsIconic($a);plannerAboveExternal=[PlannerNative]::Above($a,$b);plannerTopmost=(([PlannerNative]::GetWindowLongPtr($a,-20).ToInt64() -band 8) -ne 0);externalTopmost=(([PlannerNative]::GetWindowLongPtr($b,-20).ToInt64() -band 8) -ne 0);lastInput=[PlannerNative]::LastInput() } | ConvertTo-Json -Compress
`);
const edgeInputFile=path.join(owned,'edge-input.ps1');
fs.writeFileSync(edgeInputFile,String.raw`
param([string]$Native,[string]$Window,[string]$ExpectedOwner)
$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Owned Windows CI fixture only'}
Add-Type -Path $Native
$target=[IntPtr]([long]::Parse($Window));$owner=[uint32]::Parse($ExpectedOwner)
if($target -eq [IntPtr]::Zero -or [PlannerNative]::Owner($target) -ne $owner -or ![PlannerNative]::BrowserFrame($target)){throw 'Refusing input outside the owned browser frame'}
if(([PlannerNative]::GetWindowLongPtr($target,-20).ToInt64() -band 8) -ne 0){throw 'Owned browser unexpectedly already topmost'}
$cursor=New-Object PlannerNative+POINT;[void][PlannerNative]::GetCursorPos([ref]$cursor)
try{
 [void][PlannerNative]::ShowWindow($target,9)
 # Expose only this verified owned browser for a controlled CI click. The
 # product window is never made topmost and the test restores this flag.
 [void][PlannerNative]::SetWindowPos($target,[IntPtr](-1),0,0,0,0,0x53)
 [void][PlannerNative]::SetForegroundWindow($target)
 $rect=New-Object PlannerNative+RECT
 if(![PlannerNative]::GetWindowRect($target,[ref]$rect) -or $rect.Right-$rect.Left -lt 300 -or $rect.Bottom-$rect.Top -lt 200){throw 'Owned browser has no safe test content area'}
 if([PlannerNative]::Owner($target) -ne $owner){throw 'Owned browser window changed before test input'}
 $point=New-Object PlannerNative+POINT;$point.X=($rect.Left+$rect.Right)/2;$point.Y=($rect.Top+$rect.Bottom)/2
 if([PlannerNative]::GetAncestor([PlannerNative]::WindowFromPoint($point),2) -ne $target){throw 'Another window covers the owned browser input area'}
 [void][PlannerNative]::SetCursorPos($point.X,$point.Y)
 [PlannerNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[PlannerNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 250
}finally{
 [void][PlannerNative]::SetWindowPos($target,[IntPtr](-2),0,0,0,0,0x53)
 [void][PlannerNative]::SetCursorPos($cursor.X,$cursor.Y)
}
Start-Sleep -Milliseconds 150
@{foreground=([PlannerNative]::GetForegroundWindow() -eq $target);ownerMatches=([PlannerNative]::Owner($target) -eq $owner);lastInput=[PlannerNative]::LastInput()} | ConvertTo-Json -Compress
`);
const edgeCleanupFile=path.join(owned,'edge-cleanup.ps1');
fs.writeFileSync(edgeCleanupFile,String.raw`
param([string]$ExpectedOwner,[string]$OwnedProfile,[string]$Marker)
$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or !(Test-Path -LiteralPath $Marker)){throw 'Owned Windows CI fixture only'}
$target=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[uint32]::Parse($ExpectedOwner))
if($target){
 if(!([string]$target.ExecutablePath).EndsWith('msedge.exe',[StringComparison]::OrdinalIgnoreCase) -or ([string]$target.CommandLine).IndexOf($OwnedProfile,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Refusing to terminate a browser outside the owned profile'}
 Stop-Process -Id ([uint32]::Parse($ExpectedOwner)) -Force -ErrorAction SilentlyContinue
}
`);
const edgeDialogFile=path.join(owned,'edge-protocol-dialog.ps1');
fs.writeFileSync(edgeDialogFile,'\ufeff'+String.raw`
param([string]$Native,[string]$Window,[string]$ExpectedOwner,[ValidateSet('accept','cancel')][string]$Action,[int]$WaitMilliseconds=1500)
$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Owned Windows CI fixture only'}
Add-Type -Path $Native
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$target=[IntPtr]([long]::Parse($Window));$owner=[uint32]::Parse($ExpectedOwner)
if($target -eq [IntPtr]::Zero -or [PlannerNative]::Owner($target) -ne $owner -or ![PlannerNative]::BrowserFrame($target)){throw 'Refusing dialog input outside the owned browser'}
$end=[DateTime]::UtcNow.AddMilliseconds([Math]::Min(6000,[Math]::Max(0,$WaitMilliseconds)))
$result=@{present=$false;acted=$false;knownButtons=@();permissionAppMatched=$false;permissionTextMatched=$false;permissionSubtreeMatched=$false}
$knownApps=@('my-planner','myplanner','electron','내 플래너')
$walker=[Windows.Automation.TreeWalker]::ControlViewWalker
do{
 $root=[Windows.Automation.AutomationElement]::FromHandle($target)
 $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
 $buttons=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
 $permission=$null
 foreach($button in $buttons){
  if($button.Current.ProcessId -ne $owner -or !$button.Current.IsEnabled){continue}
  $name=$button.Current.Name
  if($name -in @('Open','Open app','Open application','Open Electron','Open MyPlanner','Open my-planner','Electron 열기','MyPlanner 열기','열기','앱 열기','Cancel','취소') -and $name -notin $result.knownButtons){$result.knownButtons+=@($name)}
  if($name -notin @('Open','Open app','Open application','Open Electron','Open MyPlanner','Open my-planner','Electron 열기','MyPlanner 열기','열기','앱 열기')){continue}
  $scope=$walker.GetParent($button)
  for($depth=0;$depth -lt 6 -and $scope -and !$scope.Equals($root);$depth++){
   $bounds=$scope.Current.BoundingRectangle
   # A small dialog subtree must contain both controls and the fixed app-open
   # permission wording. Do not treat the complete browser/page as a dialog.
   if($scope.Current.ProcessId -eq $owner -and $bounds.Width -ge 150 -and $bounds.Width -le 900 -and $bounds.Height -ge 100 -and $bounds.Height -le 550){
    $cancel=$null
    foreach($candidate in $scope.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)){
     if($candidate.Current.ProcessId -eq $owner -and $candidate.Current.IsEnabled -and $candidate.Current.Name -in @('Cancel','취소')){$cancel=$candidate;break}
    }
    $appMatched=$false;$textMatched=$false
    if($cancel){
     foreach($node in $scope.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.Condition]::TrueCondition)){
      if($node.Current.ProcessId -ne $owner){continue}
      # Inspect labels in memory only; never return arbitrary UI text or URLs.
      $label=([string]$node.Current.Name).Trim().Replace('"','').Replace("'",'').Replace('“','').Replace('”','').TrimEnd([char[]]'.?!').ToLowerInvariant()
      $label=$label -replace '\s+',' '
      if($label -in $knownApps){$appMatched=$true}
      if($label -in @('this site is trying to open','this site wants to open') -or $label.Contains('wants to open this application')){$textMatched=$true}
      foreach($knownApp in $knownApps){
       if($label -in @("this site is trying to open $knownApp","this site wants to open $knownApp","open $knownApp")){$appMatched=$true;$textMatched=$true}
      }
     }
    }
    $result.permissionAppMatched=$result.permissionAppMatched -or $appMatched
    $result.permissionTextMatched=$result.permissionTextMatched -or $textMatched
    if($cancel -and $appMatched -and $textMatched){$permission=@{open=$button;cancel=$cancel};$result.permissionSubtreeMatched=$true;break}
   }
   $scope=$walker.GetParent($scope)
  }
  if($permission){break}
 }
 # Generic Open is allowed only in the verified owned app-permission subtree.
 # No arbitrary UI, checkbox or browser policy is changed to skip confirmation.
 if($permission){
  $result.present=$true
  $chosen=if($Action -eq 'accept'){$permission.open}else{$permission.cancel}
  $invoke=$chosen.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke();$result.acted=$true;break
 }
 Start-Sleep -Milliseconds 100
}while([DateTime]::UtcNow -lt $end)
$result | ConvertTo-Json -Compress
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
  }elseif($c.action -eq 'hide'){
   [void][PlannerNative]::LockSetForegroundWindow(2);$form.Hide();Save-State @{id=[int]$c.id;ready=$true;hidden=$true}
  }elseif($c.action -eq 'stop'){
   [void][PlannerNative]::LockSetForegroundWindow(2);Save-State @{id=[int]$c.id;ready=$true;stopped=$true};$form.Close()
  }else{throw 'Unknown fixture command'}
 }catch{Save-State @{id=$script:last;error='Foreign fixture failed';type=$_.Exception.GetType().Name};$form.Close()}
})
$form.Add_Shown({Save-State @{id=0;ready=$true;pid=$PID;hwnd=$form.Handle.ToInt64().ToString()};$timer.Start()})
try{[Windows.Forms.Application]::Run($form)}finally{[void][PlannerNative]::LockSetForegroundWindow(2);$timer.Stop();$timer.Dispose();$form.Dispose();[void][PlannerNative]::SetCursorPos($cursor.X,$cursor.Y)}
`);
function probe(planner='0', external='0', browserOwner='0') {
  const text = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',probeFile,'-Native',nativeFile,'-Planner',planner,'-External',external,'-BrowserOwner',String(browserOwner)], { encoding:'utf8', windowsHide:true, timeout:12000 });
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
async function registerOwnedProtocol() {
  const scheme='tteodori-planner';
  // The public protocol must never dispatch to a default-profile source app.
  // Only the exact installation created by this workflow may be overridden.
  const actualExecutable=await running.evaluate(()=>process.execPath);
  const installRoot=path.resolve(process.env.RUNNER_TEMP,'my-planner-installed');
  const installedExecutable=path.join(installRoot,'MyPlanner.exe');
  const normalize=value=>path.resolve(value).toLowerCase();
  if(!packaged||normalize(executable)!==normalize(installedExecutable)||normalize(actualExecutable)!==normalize(installedExecutable))throw inconclusive('Protocol handoff is restricted to the verified owned CI installation');
  const exists=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[bool](Test-Path 'Registry::HKEY_CLASSES_ROOT\\tteodori-planner') | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true,timeout:8000}).trim());
  const priorOwn=exists&&await running.evaluate(({app},scheme)=>app.isDefaultProtocolClient(scheme,process.execPath,[]),scheme);
  if(exists&&!priorOwn)throw inconclusive('Unknown application protocol registration exists; refusing to replace it');
  protocolRegistration=await running.evaluate(({app},{scheme,profile,priorOwn})=>{
    if(process.env.CI!=='true'||process.env.RUNNER_OS!=='Windows'||app.getPath('userData')!==profile)throw Error('Owned Windows CI profile only');
    const args=['--user-data-dir='+profile];
    const executable=process.execPath;
    // require is not a normal global in the inspector evaluation context.
    // Load only the validated installed app's own protocol classifier.
    const appRequire=process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(),'package.json'));
    const {classifyAppLaunch}=appRequire('./app-return.js');
    globalThis.__returnDiagnostic.protocolRequests=0;
    app.on('second-instance',(_event,argv)=>{if(classifyAppLaunch(argv)==='return')globalThis.__returnDiagnostic.protocolRequests++});
    const registered=app.setAsDefaultProtocolClient(scheme,executable,args);
    return{scheme,executable,args,registered,priorOwn,matches:app.isDefaultProtocolClient(scheme,executable,args)};
  },{scheme,profile,priorOwn});
  if(!protocolRegistration.registered||!protocolRegistration.matches)throw inconclusive('Owned application protocol registration was not confirmed');
}
function protocolDialog(handle,owner,action,wait=1500) {
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',edgeDialogFile,'-Native',nativeFile,'-Window',handle,'-ExpectedOwner',String(owner),'-Action',action,'-WaitMilliseconds',String(wait)],{encoding:'utf8',windowsHide:true,timeout:10000}).trim());
}
async function protocolObservation(browserPage,handle,owner) {
  const requests=()=>running.evaluate(()=>globalThis.__returnDiagnostic.protocolRequests);
  const result={status:'running',ownedRegistration:true,automaticRequests:await requests()};
  try{
    // The current callback may already have triggered a browser permission
    // prompt. Decline it in this synthetic run before testing the visible link.
    result.initialPrompt=protocolDialog(handle,owner,'cancel');
    result.automaticRequests=await requests();
    if(result.automaticRequests>0){
      result.path='automatic application handoff';
    }else{
      if(browserPage.isClosed())throw inconclusive('Completion tab closed before the explicit application-return button could be tested');
      try{
        const link=browserPage.locator('#open-planner');
        if(await link.count()!==1||await link.getAttribute('href')!=='tteodori-planner://open')throw inconclusive('Completion page has no fixed application-return link');
        await browserPage.bringToFront();
        const before=probe(plannerHandle,handle);
        if(!before.externalForeground||before.externalPid!==owner)throw inconclusive('Owned Edge frame was not foreground for the explicit link click');
        const beforeRequests=await requests();
        try{await link.click({timeout:4000,noWaitAfter:true})}
        catch{if(!browserPage.isClosed()||await requests()<=beforeRequests)throw inconclusive('Explicit application-return link did not complete its browser click')}
        if(!browserPage.isClosed())result.confirmation=protocolDialog(handle,owner,'accept',6000);
        await until(async()=>await requests()>beforeRequests,'Application-return handoff did not reach the existing isolated instance',6000);
        result.explicitRequests=(await requests())-beforeRequests;result.path='explicit browser link and unmodified browser confirmation policy';
      }catch(error){
        if(browserPage.isClosed()&&await requests()>0)result.path='application handoff completed while the browser return link was being inspected';
        else throw error.inconclusive?error:inconclusive('Owned browser return-link inspection did not complete');
      }
    }
    await pause(350);result.settled=observation(probe(plannerHandle,handle));
    result.callbackClosed=browserPage.isClosed();result.totalRequests=await requests();
    result.singleWindow=await running.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length===1);
    assert(result.singleWindow,'Application handoff created another window');
    result.status='conclusive-observation';
  }catch(error){result.status=error.inconclusive?'inconclusive':'error';result.errors=[{kind:error.name,message:safeMessage(error)}];if(!error.inconclusive)process.exitCode=1}
  return result;
}
async function edgeObservation() {
  const edge=report.edge={browser:'Installed Microsoft Edge, headful, disposable owned profile',status:'running',states:[],attempts:[],blockedRequests:0,errors:[]};
  const edgeProfile=path.join(owned,'edge-profile');
  const tokenCalls=async()=>running.evaluate(()=>globalThis.__returnDiagnostic.networkCalls);
  const initialCalls=await tokenCalls();
  let browserMainPid;
  try{
    await command('hide');
    edgeServer=http.createServer((req,res)=>{
      const allowed=req.method==='GET'&&['/start','/continue'].includes(req.url);
      res.writeHead(allowed?200:404,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'",'Referrer-Policy':'no-referrer',Connection:'close'});
      res.end(allowed?'<!doctype html><html><head><title>Planner synthetic browser return</title></head><body><h1>Isolated browser return diagnostic</h1><p>No Google account or personal data.</p></body></html>':'Not found');
    });
    await new Promise((resolve,reject)=>{edgeServer.once('error',reject);edgeServer.listen(0,'127.0.0.1',resolve)});
    const origin='http://127.0.0.1:'+edgeServer.address().port;
    let allowedCallbackPort;
    try{edgeContext=await chromium.launchPersistentContext(edgeProfile,{
      channel:'msedge',headless:false,serviceWorkers:'block',viewport:{width:1040,height:700},
      // Even browser-background traffic can only reach a closed loopback proxy;
      // page routing additionally permits only our two owned loopback servers.
      // Order matters: Playwright otherwise appends <-loopback> after the
      // explicit exception and sends our own callback through the closed proxy.
      proxy:{server:'http://127.0.0.1:9',bypass:'<-loopback>,127.0.0.1'},
      args:['--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check'],
      timeout:25000,
    })}catch{throw inconclusive('Installed Microsoft Edge could not start with an isolated headful profile')}
    await edgeContext.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(['tteodori-planner://open','tteodori-planner://open/'].includes(u.href)&&protocolRegistration?.matches)return route.continue();
      const own=u.protocol==='http:'&&u.hostname==='127.0.0.1'&&(
        (u.port===String(edgeServer.address().port)&&['/start','/continue'].includes(u.pathname))||
        (u.port===allowedCallbackPort&&u.pathname==='/auth/callback'));
      if(!own){edge.blockedRequests++;return route.abort()}
      return route.continue();
    });
    const browserSession=await edgeContext.browser().newBrowserCDPSession();
    const browserVersion=await browserSession.send('Browser.getVersion');
    edge.version=/Edg\/([0-9.]+)/.exec(browserVersion.userAgent)?.[1]||edgeContext.browser().version();
    edge.chromiumVersion=/\/([0-9.]+)$/.exec(browserVersion.product)?.[1]||'unavailable';
    const launch=await browserSession.send('Browser.getBrowserCommandLine');
    const profileArgument=launch.arguments.find(arg=>arg.startsWith('--user-data-dir='));
    assert(profileArgument&&path.resolve(profileArgument.slice('--user-data-dir='.length)).toLowerCase()===path.resolve(edgeProfile).toLowerCase(),'Refusing a browser outside the owned profile');
    const processes=await browserSession.send('SystemInfo.getProcessInfo');
    browserMainPid=processes.processInfo.find(item=>item.type==='browser')?.id;
    assert(Number.isSafeInteger(browserMainPid)&&browserMainPid>0,'Could not identify owned Edge browser process');
    const build=await page.evaluate(()=>window.plannerApp.getBuildInfo());
    const protocolEnabled=await running.evaluate(({app})=>app.isPackaged)&&build.accountTestBuild!==true;
    edge.protocolEnabled=protocolEnabled;
    if(protocolEnabled)await registerOwnedProtocol();
    // Keep a harmless second tab so browsers that allow close() do not destroy
    // the entire owned frame before native measurements can be recorded.
    const keeper=edgeContext.pages()[0]||await edgeContext.newPage();await keeper.goto(origin+'/start');
    let previousCallback=await running.evaluate(()=>globalThis.__returnDiagnostic.callback);
    for(const mode of ['normal','hidden','minimized']){
      const attempt={mode,pendingBefore:(await page.evaluate(()=>window.plannerAccount.getState())).auth.pending===true,freshCapture:false,callbackRequestMatched:false,callbackHttpStatus:null,navigationError:null};
      edge.attempts.push(attempt);
      await until(async()=>!(await page.evaluate(()=>window.plannerAccount.getState())).auth.pending,'Previous Edge login attempt was still pending');
      const browserPage=await edgeContext.newPage();
      await browserPage.goto(origin+'/start');await browserPage.goto(origin+'/continue');
      const historyReady=await browserPage.evaluate(()=>history.length>=2);
      assert(historyReady,'Synthetic browser history was not established');
      await running.evaluate(()=>{globalThis.__returnDiagnostic.callback=null});
      await page.evaluate(()=>window.plannerAccount.signInGoogle());
      const raw=await until(()=>running.evaluate(()=>globalThis.__returnDiagnostic.callback),'Edge login did not capture a new browser callback');
      attempt.freshCapture=raw!==previousCallback;
      if(!attempt.freshCapture)throw inconclusive('Edge login reused an earlier captured callback');
      previousCallback=raw;
      const callback=new URL(raw);callback.searchParams.set('code','SYNTHETIC_WINDOWS_RETURN_CODE');allowedCallbackPort=callback.port;
      browserPage.on('request',request=>{
        if(!request.isNavigationRequest())return;
        const u=new URL(request.url());
        if(u.host===callback.host&&u.pathname===callback.pathname)attempt.callbackRequestMatched=request.url()===callback.href;
      });
      browserPage.on('response',response=>{
        const request=response.request();
        if(request.isNavigationRequest()&&request.url()===callback.href){attempt.callbackHttpStatus=response.status();attempt.callbackHttpRejected=response.status()>=400}
      });
      await plannerState(mode);await browserPage.bringToFront();
      const frame=probe(plannerHandle,'0',browserMainPid);
      if(!frame.externalHandle||frame.externalHandle==='0'||frame.externalPid!==browserMainPid)throw inconclusive('Owned Edge native frame was not found');
      const input=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',edgeInputFile,'-Native',nativeFile,'-Window',frame.externalHandle,'-ExpectedOwner',String(browserMainPid)],{encoding:'utf8',windowsHide:true,timeout:12000}).trim());
      const before=probe(plannerHandle,frame.externalHandle);
      const checks={edgeForeground:input.foreground&&before.externalForeground,edgeOwnerMatches:input.ownerMatches&&before.externalPid===browserMainPid,plannerOwnerMatches:before.plannerPid===plannerPid,edgeNotTopmost:!before.externalTopmost,inputUnchanged:before.lastInput===input.lastInput};
      if(Object.values(checks).some(passed=>!passed))throw inconclusive('Edge foreground precondition unstable: '+JSON.stringify(checks));
      const calls=await tokenCalls();
      if(protocolEnabled)await running.evaluate(()=>{globalThis.__returnDiagnostic.protocolRequests=0});
      try{
        const response=await browserPage.goto(callback.href,{waitUntil:'domcontentloaded',timeout:12000});
        if(response){attempt.callbackHttpStatus=response.status();attempt.callbackHttpRejected=response.status()>=400}
      }catch(error){
        const code=/net::(ERR_[A-Z_]+)/.exec(String(error?.message||''))?.[1];
        attempt.navigationError=code||(browserPage.isClosed()?'TARGET_CLOSED':error?.name==='TimeoutError'?'NAVIGATION_TIMEOUT':'NAVIGATION_INTERRUPTED');
      }
      if(attempt.callbackHttpRejected)throw inconclusive('Owned Edge callback returned a rejected HTTP status');
      await until(async()=>{
        const count=await tokenCalls();attempt.pkceAdvanced=count===calls+1;
        if(count>calls+1)throw inconclusive('Edge callback unexpectedly repeated the synthetic PKCE exchange');
        return attempt.pkceAdvanced;
      },'Edge callback did not reach the synthetic PKCE exchange');
      await until(async()=>!(await page.evaluate(()=>window.plannerAccount.getState())).auth.pending,'Completed Edge login remained pending');
      await pause(350);const baseline=probe(plannerHandle,frame.externalHandle);
      const settledAuth=(await page.evaluate(()=>window.plannerAccount.getState())).auth;
      attempt.authenticated=settledAuth.authenticated===true;attempt.pendingAfter=settledAuth.pending===true;
      assert.equal(attempt.authenticated,true);
      const closed=browserPage.isClosed();
      let queryRemoved=closed;
      if(!closed){try{
        const completion=await browserPage.evaluate(()=>({urlCleaned:location.pathname==='/auth/complete'&&location.search===''&&location.hash==='',completionDom:document.title==='로그인 완료 · 내 플래너'&&document.querySelector('main h1')?.textContent==='로그인 완료'}));
        queryRemoved=completion.urlCleaned;attempt.completionDom=completion.completionDom;
      }
        catch{if(browserPage.isClosed())queryRemoved=true;else throw inconclusive('Owned Edge callback URL cleanup could not be observed')}}
      attempt.urlCleaned=queryRemoved;
      if(attempt.navigationError){
        const permittedAbort=['ERR_ABORTED','ERR_UNKNOWN_URL_SCHEME','TARGET_CLOSED','NAVIGATION_TIMEOUT'].includes(attempt.navigationError);
        const handoff=browserPage.isClosed()&&protocolEnabled&&(await running.evaluate(()=>globalThis.__returnDiagnostic.protocolRequests))>0;
        const currentSuccess=attempt.freshCapture&&attempt.callbackRequestMatched&&attempt.callbackHttpStatus===200&&attempt.pkceAdvanced&&attempt.authenticated&&!attempt.pendingAfter;
        attempt.navigationAbortValidated=permittedAbort&&currentSuccess&&((attempt.completionDom&&queryRemoved)||handoff);
        if(!attempt.navigationAbortValidated)throw inconclusive('Edge navigation interruption lacked a validated completed login');
      }
      if(!queryRemoved)throw inconclusive('Edge callback did not remove authentication URL parameters');
      await running.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];if(w.isMinimized())w.restore();w.show();w.focus();w.moveTop()});
      await pause(350);const candidate=probe(plannerHandle,frame.externalHandle);
      const state={mode,precondition:checks,historyReady,callbackClosed:closed,authenticationUrlRemoved:queryRemoved,currentProduct:{settled:observation(baseline),inputUnchanged:baseline.lastInput===before.lastInput},directCandidate:{operations:'restore/show/focus/moveTop after the real Edge navigation; no product patch',settled:observation(candidate),inputUnchanged:candidate.lastInput===before.lastInput}};
      edge.states.push(state);
      if(baseline.lastInput!==before.lastInput||candidate.lastInput!==before.lastInput)throw inconclusive('Native input changed during Edge callback observation');
      assert.equal(candidate.plannerTopmost,false,'Candidate left product permanently topmost');
      if(protocolEnabled)state.protocol=await protocolObservation(browserPage,frame.externalHandle,browserMainPid);
      if(!browserPage.isClosed())await browserPage.close();
    }
    edge.nativeStatus='conclusive-observation';
    edge.status=protocolEnabled&&edge.states.some(state=>state.protocol?.status!=='conclusive-observation')?'partial-observation':'conclusive-observation';
  }catch(error){
    edge.status=error.inconclusive?'inconclusive':'error';edge.errors.push({kind:error.name,message:safeMessage(error)});
    // This diagnostic must not label a missing/unusable Edge as a product pass.
    if(!error.inconclusive)process.exitCode=1;
  }finally{
    try{
      const finalCalls=await bounded(tokenCalls().catch(()=>null),6000,null);
      if(finalCalls===null)throw Error('Synthetic app transport counters unavailable');
      edge.exchangeDelta=finalCalls-initialCalls;
    }catch{edge.errors.push({message:'Synthetic app transport counters unavailable during cleanup'});process.exitCode=1}
    if(protocolRegistration){
      try{
        edge.protocolRegistrationCleaned=await bounded(running.evaluate(({app},registration)=>{
          if(!app.isDefaultProtocolClient(registration.scheme,registration.executable,registration.args))return false;
          if(registration.priorOwn){
            const restored=app.setAsDefaultProtocolClient(registration.scheme,registration.executable,[]);
            return restored&&app.isDefaultProtocolClient(registration.scheme,registration.executable,[]);
          }
          return app.removeAsDefaultProtocolClient(registration.scheme,registration.executable,registration.args);
        },protocolRegistration).catch(()=>false),6000,false);
        edge.protocolRegistrationCleanup=protocolRegistration.priorOwn?'restored the exact prior owned installer registration':'removed the temporary owned registration';
        if(!edge.protocolRegistrationCleaned)throw Error('Owned protocol registration cleanup was not confirmed');
      }catch{edge.errors.push({message:'Owned protocol registration cleanup failed'});process.exitCode=1}
      protocolRegistration=null;
    }
    if(edgeContext){
      const closed=await bounded(edgeContext.close().then(()=>true,()=>false),8000,false);
      if(!closed){
        try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',edgeCleanupFile,'-ExpectedOwner',String(browserMainPid),'-OwnedProfile',edgeProfile,'-Marker',marker],{encoding:'utf8',windowsHide:true,timeout:8000});edge.browserCleanup='terminated only the verified owned browser'}
        catch{edge.errors.push({message:'Owned Edge context cleanup failed'});process.exitCode=1}
      }else edge.browserCleanup='closed';
      edgeContext=null;
    }
    if(edgeServer){edgeServer.closeAllConnections();const closed=await bounded(new Promise(resolve=>edgeServer.close(()=>resolve(true))),2500,false);if(!closed){edge.errors.push({message:'Owned loopback server cleanup timed out'});process.exitCode=1}edgeServer=null}
  }
}
(async()=>{
  const environment=probe();report.desktop={session:environment.session,inputDesktop:environment.inputDesktop};
  if(!environment.inputDesktop||environment.session===0)throw inconclusive('No interactive native input desktop in this runner session');
  running=await _electron.launch({executablePath:executable,cwd:root,args:[...(packaged?[]:['.']),'--user-data-dir='+profile],env:{...process.env,CI:'true',PLANNER_DISABLE_AUTO_UPDATE:'1'},timeout:30000});
  const actual=await running.evaluate(({app})=>app.getPath('userData'));
  assert.equal(path.resolve(actual).toLowerCase(),path.resolve(profile).toLowerCase(),'Refusing to touch a non-owned app profile');
  Object.assign(report.runtime,await running.evaluate(({app})=>({electronVersion:process.versions.electron,appVersion:app.getVersion()})));
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
  await edgeObservation();
  const total=await running.evaluate(()=>({calls:globalThis.__returnDiagnostic.networkCalls,unexpected:globalThis.__returnDiagnostic.unexpected}));
  report.networkCalls=total.calls;report.unexpectedNetworkCalls=total.unexpected;
  assert.equal(total.unexpected,0);assert.equal(total.calls,3+report.edge.exchangeDelta);
  assert(Number.isInteger(report.edge.exchangeDelta)&&report.edge.exchangeDelta>=0&&report.edge.exchangeDelta<=3,'Unexpected number of Edge synthetic exchanges');
  if(report.edge.status==='conclusive-observation')assert.equal(report.edge.exchangeDelta,3);
  else report.status='partial-observation';
  if(packaged){
    if(report.edge.nativeStatus!=='conclusive-observation'||report.edge.states.length!==3||report.edge.states.some(state=>state.protocol?.status!=='conclusive-observation')){
      process.exitCode=1;throw inconclusive('Installed app return was not verified in all three actual Edge scenarios');
    }
    for(const state of report.edge.states){
      assert.equal(state.protocol.settled.foregroundPlanner,true,'Installed browser handoff did not give the planner native foreground');
      assert.equal(state.protocol.singleWindow,true,'Installed browser handoff created another app window');
      assert.equal(state.protocol.settled.topmost,false,'Installed browser handoff left the planner permanently topmost');
    }
    report.installedReturnVerified=true;
  }
})().catch(error=>{
  report.status=error.inconclusive?'inconclusive':'error';report.errors.push({kind:error.name,message:safeMessage(error)});
  if(packaged||!error.inconclusive)process.exitCode=1;
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
  if(running)try{const done=running.waitForEvent('close',{timeout:10000});await bounded(running.evaluate(({app})=>app.quit()).catch(()=>{}),3000,null);await done}catch{await bounded(running.close().catch(()=>{}),5000,null)}
  if(packaged&&!report.installedReturnVerified)process.exitCode=1;
  try{if(fs.existsSync(marker))fs.rmSync(owned,{recursive:true,force:true,maxRetries:8,retryDelay:100});report.cleanup='removed'}catch(error){report.cleanup={error:safeMessage(error)};process.exitCode=1}
  const label=packaged?'installed':'source';
  fs.writeFileSync(path.join(output,'windows-google-return-'+label+'.json'),JSON.stringify(report,null,2)+'\n');
  const compact=publicSummary(report);
  const notice=JSON.stringify(compact).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
  console.log('::notice title=Windows OAuth return diagnostic ('+label+')::'+notice);
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### Windows OAuth return diagnostic ('+label+')\n\n```json\n'+JSON.stringify(compact,null,2)+'\n```\n\nA conclusive observation is not a claim that a real Google login or user-PC focus is fixed.\n');
});
