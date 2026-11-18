// Read-only validation immediately after this workflow's silent NSIS install,
// before any installed application has been launched. No URI is dispatched.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function inspectRegistration(snapshot, executable) {
  const equal = (value, expected) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
  return {
    registered: snapshot?.exists === true,
    urlProtocolMarker: snapshot?.markerExists === true && snapshot.marker === '',
    ownQuotedCommand: equal(snapshot?.command, `"${executable}" "%1"`),
    ownQuotedIcon: equal(snapshot?.icon, `"${executable}",0`),
    installedAppNotRunning: snapshot?.notRunning === true,
  };
}

function main() {
  const report = { installedProtocolVerified: false, readOnly: true };
  let reason = 'owned-install-required';
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.CI !== 'true' || process.env.RUNNER_OS !== 'Windows' || !process.env.RUNNER_TEMP || !process.env.PLANNER_EXECUTABLE) throw Error();
    const executable = path.resolve(process.env.PLANNER_EXECUTABLE);
    const expected = path.resolve(process.env.RUNNER_TEMP, 'my-planner-installed', 'MyPlanner.exe');
    if (executable.toLowerCase() !== expected.toLowerCase() || !fs.statSync(executable).isFile()) throw Error();
    reason = 'registry-inspection-failed';
    const script = String.raw`
$ErrorActionPreference='Stop'
try {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$base.OpenSubKey('Software\Classes\tteodori-planner')
  $snapshot=@{exists=$null -ne $key;markerExists=$false;marker=$null;command=$null;icon=$null;notRunning=$true}
  if($key){
    try {
      $snapshot.markerExists=$key.GetValueNames() -contains 'URL Protocol'
      $snapshot.marker=$key.GetValue('URL Protocol',$null)
      $commandKey=$key.OpenSubKey('shell\open\command')
      if($commandKey){try{$snapshot.command=$commandKey.GetValue('',$null)}finally{$commandKey.Dispose()}}
      $iconKey=$key.OpenSubKey('DefaultIcon')
      if($iconKey){try{$snapshot.icon=$iconKey.GetValue('',$null)}finally{$iconKey.Dispose()}}
    }finally{$key.Dispose()}
  }
  $base.Dispose()
  foreach($candidate in Get-CimInstance Win32_Process -Filter "Name = 'MyPlanner.exe'"){
    if([string]::Equals([string]$candidate.ExecutablePath,$env:PLANNER_PROTOCOL_CHECK_EXECUTABLE,[StringComparison]::OrdinalIgnoreCase)){$snapshot.notRunning=$false}
  }
  $snapshot | ConvertTo-Json -Compress
}catch {
  @{inspectionFailed=$true} | ConvertTo-Json -Compress
  exit 1
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PLANNER_PROTOCOL_CHECK_EXECUTABLE: executable },
      windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    });
    if (result.error || result.status !== 0) throw Error();
    const snapshot = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
    report.checks = inspectRegistration(snapshot, executable);
    reason = 'registration-mismatch';
    if (!Object.values(report.checks).every(Boolean)) throw Error();
    report.installedProtocolVerified = true;
  } catch {
    report.reason = reason;
    process.exitCode = 1;
  }
  // Registry values, executable paths, command lines and environment values
  // remain in memory. Only this bounded boolean result is an artifact/log.
  const directory = path.resolve(__dirname, '../test-results');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installer-protocol.json'), JSON.stringify(report, null, 2) + '\n');
  const annotation = report.installedProtocolVerified ? 'notice' : 'error';
  console.log(`::${annotation} title=NSIS app-open registration::` + JSON.stringify(report));
  if (report.installedProtocolVerified) console.log('PASS: NSIS registered its owned app-open handler before the first installed app launch.');
}

module.exports = { inspectRegistration };
if (require.main === module) main();
