// Destructive only inside the exact disposable Windows CI installation.
// Checks the real update/uninstall hooks; never dispatches a protocol URI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectRegistration } = require('./check-installed-protocol.cjs');

const UPDATE_PROOF = 'Actual NSIS update/relaunch retains tasks, practices, missed days, point event, theme and local backups';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const failed = code => Object.assign(new Error(code), { lifecycleCode: code });

function validateRunContext({ platform, arch, env, sourceRoot }) {
  if (platform !== 'win32' || arch !== 'x64' || env.CI !== 'true' || env.RUNNER_OS !== 'Windows'
      || !env.RUNNER_TEMP || !env.PLANNER_EXECUTABLE || !path.win32.isAbsolute(env.RUNNER_TEMP)
      || !path.win32.isAbsolute(sourceRoot) || !/^[a-z]:\\$/i.test(path.win32.parse(env.RUNNER_TEMP).root)
      || !/^[a-z]:\\$/i.test(path.win32.parse(sourceRoot).root)) throw failed('OWNED_CI_REQUIRED');
  const installDir = path.win32.resolve(env.RUNNER_TEMP, 'my-planner-installed');
  const executable = path.win32.join(installDir, 'MyPlanner.exe');
  if (!equal(path.win32.resolve(env.PLANNER_EXECUTABLE), executable)) throw failed('OWNED_CI_REQUIRED');
  return {
    installDir, executable,
    uninstaller: path.win32.join(installDir, 'Uninstall MyPlanner.exe'),
    installer: path.win32.resolve(sourceRoot, 'dist', 'MyPlanner-Setup.exe'),
    sentinelCommand: `"${path.win32.join(installDir, 'ProtocolLifecycleSentinel.exe')}" -- "%1"`,
  };
}

function updateWasVerified(proof, baseVersion, nextVersion) {
  return !!proof && proof.baseVersion === baseVersion && proof.nextVersion === nextVersion
    && nextVersion !== baseVersion && Array.isArray(proof.errors) && proof.errors.length === 0
    && Array.isArray(proof.passed) && proof.passed.includes(UPDATE_PROOF)
    && (proof.cleanup === 'removed' || (proof.cleanup && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(proof.cleanup.code)));
}

function ownedRegistration(snapshot, executable) {
  return Object.values(inspectRegistration(snapshot, executable)).every(Boolean)
    && snapshot.machineRegistrationExists === false && snapshot.noPlannerProcess === true;
}
function ownSentinel(snapshot, command, marker) {
  return snapshot?.exists === true && snapshot.fixtureMarker === marker && equal(snapshot.command, command)
    && snapshot.markerExists === true && snapshot.marker === '' && snapshot.noPlannerProcess === true
    && snapshot.machineRegistrationExists === false;
}
function removedRegistration(snapshot) {
  return snapshot?.exists === false && snapshot.noPlannerProcess === true && snapshot.machineRegistrationExists === false;
}

const registryScript = String.raw`
$ErrorActionPreference='Stop'
try {
  if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'Guard'}
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
  $machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $machineKey=$machine.OpenSubKey('Software\Classes\tteodori-planner')
  $machineExists=$null -ne $machineKey
  if($machineKey){$machineKey.Dispose()};$machine.Dispose()
  $running=@(Get-CimInstance Win32_Process -Filter "Name = 'MyPlanner.exe'").Count -gt 0
  $key=$base.OpenSubKey('Software\Classes\tteodori-planner',$env:PLANNER_LIFECYCLE_ACTION -ne 'inspect')
  try {
    $snapshot=@{exists=$null -ne $key;markerExists=$false;marker=$null;command=$null;icon=$null;notRunning=!$running;noPlannerProcess=!$running;machineRegistrationExists=$machineExists;fixtureMarker=$null}
    if($key){
      $snapshot.markerExists=$key.GetValueNames() -contains 'URL Protocol'
      $snapshot.marker=$key.GetValue('URL Protocol',$null)
      $snapshot.fixtureMarker=$key.GetValue('PlannerProtocolLifecycleFixture',$null)
      $commandKey=$key.OpenSubKey('shell\open\command')
      if($commandKey){try{$snapshot.command=$commandKey.GetValue('',$null)}finally{$commandKey.Dispose()}}
      $iconKey=$key.OpenSubKey('DefaultIcon')
      if($iconKey){try{$snapshot.icon=$iconKey.GetValue('',$null)}finally{$iconKey.Dispose()}}
    }
    if($env:PLANNER_LIFECYCLE_ACTION -eq 'inspect'){$snapshot | ConvertTo-Json -Compress;exit 0}
    if($running -or $machineExists -or !$key){throw 'Guard'}
    if($env:PLANNER_LIFECYCLE_ACTION -eq 'sentinel'){
      if($snapshot.fixtureMarker -or !$snapshot.markerExists -or $snapshot.marker -ne '' -or ![string]::Equals([string]$snapshot.command,$env:PLANNER_LIFECYCLE_EXPECTED,[StringComparison]::OrdinalIgnoreCase)){throw 'Guard'}
      $key.SetValue('PlannerProtocolLifecycleFixture',$env:PLANNER_LIFECYCLE_MARKER,[Microsoft.Win32.RegistryValueKind]::String)
      $commandKey=$null
      try {
        $commandKey=$key.OpenSubKey('shell\open\command',$true)
        if(!$commandKey){throw 'Guard'}
        $commandKey.SetValue('',$env:PLANNER_LIFECYCLE_SENTINEL,[Microsoft.Win32.RegistryValueKind]::String)
      }catch {
        # Roll back only our marker when the command is still the exact original.
        # A changed foreign command is never overwritten or removed.
        if($commandKey -and $key.GetValue('PlannerProtocolLifecycleFixture',$null) -eq $env:PLANNER_LIFECYCLE_MARKER -and [string]::Equals([string]$commandKey.GetValue('',$null),$env:PLANNER_LIFECYCLE_EXPECTED,[StringComparison]::OrdinalIgnoreCase)){$key.DeleteValue('PlannerProtocolLifecycleFixture',$false)}
        throw
      }finally{if($commandKey){$commandKey.Dispose()}}
      @{changed=$true} | ConvertTo-Json -Compress
    }elseif($env:PLANNER_LIFECYCLE_ACTION -eq 'cleanup'){
      if($snapshot.fixtureMarker -ne $env:PLANNER_LIFECYCLE_MARKER -or ![string]::Equals([string]$snapshot.command,$env:PLANNER_LIFECYCLE_SENTINEL,[StringComparison]::OrdinalIgnoreCase)){throw 'Guard'}
      $key.Dispose();$key=$null
      $base.DeleteSubKeyTree('Software\Classes\tteodori-planner',$false)
      @{removed=$true} | ConvertTo-Json -Compress
    }else{throw 'Guard'}
  }finally{if($key){$key.Dispose()};$base.Dispose()}
}catch{
  @{workerFailed=$true} | ConvertTo-Json -Compress
  exit 1
}
`;

function registry(action, values = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryScript], {
    env: { ...process.env, PLANNER_LIFECYCLE_ACTION: action,
      PLANNER_LIFECYCLE_EXPECTED: values.expected || '', PLANNER_LIFECYCLE_SENTINEL: values.command || '', PLANNER_LIFECYCLE_MARKER: values.marker || '' },
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  if (result.error || result.status !== 0) throw failed('REGISTRY_WORKER_FAILED');
  try { return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')); }
  catch { throw failed('REGISTRY_WORKER_FAILED'); }
}

function regularOwnedFile(file, root) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
      || !equal(fs.realpathSync(root), path.resolve(root)) || !equal(fs.realpathSync(file), path.resolve(file))) throw failed('OWNED_FILE_REQUIRED');
}
function runExecutable(file, args) {
  const result = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw failed('INSTALLER_PROCESS_FAILED');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForRemoval(executable) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    // The executable can disappear before NSIS finishes removing shortcuts and
    // its own files. Do not race a reinstall against that unfinished removal.
    if (!fs.existsSync(path.dirname(executable))) {
      const snapshot = registry('inspect');
      if (snapshot.noPlannerProcess) return snapshot;
    }
    await pause(200);
  }
  throw failed('UNINSTALL_NOT_COMPLETED');
}

async function verifyLifecycle(io, files, report, marker) {
  let changedSentinel = false;
  let primaryError;
  try {
    report.phase = 'post-update-registration';
    const updated = io.inspect();
    if (!ownedRegistration(updated, files.executable)) throw failed('POST_UPDATE_REGISTRATION_MISMATCH');
    report.checks.postUpdateRegistration = true;

    report.phase = 'own-uninstall';
    io.uninstall();
    const removed = await io.waitRemoved();
    if (!removedRegistration(removed)) throw failed('OWN_REGISTRATION_NOT_REMOVED');
    report.checks.ownUninstallRemovesRegistration = true;

    report.phase = 'reinstall-owned-fixture';
    io.reinstall();
    const reinstalled = io.inspect();
    if (!ownedRegistration(reinstalled, files.executable)) throw failed('REINSTALL_REGISTRATION_MISMATCH');
    report.checks.reinstallRegistration = true;

    report.phase = 'foreign-registration-fixture';
    // Guard immediately before mutation as well as inside the PowerShell worker.
    changedSentinel = true;
    io.sentinel({ expected: reinstalled.command, command: files.sentinelCommand, marker });
    if (!ownSentinel(io.inspect(), files.sentinelCommand, marker)) throw failed('SENTINEL_NOT_CONFIRMED');

    report.phase = 'foreign-owner-uninstall';
    io.uninstall();
    const preserved = await io.waitRemoved();
    if (!ownSentinel(preserved, files.sentinelCommand, marker)) throw failed('FOREIGN_REGISTRATION_NOT_PRESERVED');
    report.checks.otherOwnerPreserved = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (changedSentinel) {
      // Never remove another handler when an unexpected change occurs.
      try {
        const snapshot = io.inspect();
        if (ownedRegistration(snapshot, files.executable) && !snapshot.fixtureMarker) {
          // A worker failure before mutation (or its exact rollback) left no
          // sentinel to remove. Preserve the original registration and failure.
          report.checks.sentinelCleanup = true;
        } else {
          if (!ownSentinel(snapshot, files.sentinelCommand, marker)) throw failed('SENTINEL_OWNERSHIP_CHANGED');
          io.cleanup({ command: files.sentinelCommand, marker });
          report.checks.sentinelCleanup = removedRegistration(io.inspect());
        }
        if (!report.checks.sentinelCleanup) throw failed('SENTINEL_CLEANUP_FAILED');
      } catch (error) {
        report.checks.sentinelCleanup = false;
        report.cleanupReason = error.lifecycleCode || 'SENTINEL_CLEANUP_FAILED';
        if (!primaryError) throw error;
      }
    }
  }
}

async function main() {
  const report = { protocolLifecycleVerified: false, checks: {} };
  try {
    report.phase = 'owned-ci-guard';
    const root = path.resolve(__dirname, '..');
    const files = validateRunContext({ platform: process.platform, arch: process.arch, env: process.env, sourceRoot: root });
    regularOwnedFile(files.executable, files.installDir);
    regularOwnedFile(files.uninstaller, files.installDir);
    regularOwnedFile(files.installer, path.join(root, 'dist'));
    const pkg = require('../package.json');
    if (pkg.build?.nsis?.deleteAppDataOnUninstall !== false) throw failed('DATA_PRESERVING_UNINSTALL_REQUIRED');
    const next = require('semver').inc(pkg.version, 'patch');
    const proof = JSON.parse(fs.readFileSync(path.join(root, 'test-results/update-e2e.json'), 'utf8'));
    if (!updateWasVerified(proof, pkg.version, next)) throw failed('UPDATE_PROOF_REQUIRED');
    const archive = path.join(files.installDir, 'resources', 'app.asar');
    regularOwnedFile(archive, files.installDir);
    const installed = JSON.parse(require('@electron/asar').extractFile(archive, 'package.json').toString());
    if (installed.name !== pkg.name || installed.version !== next || installed.plannerAccountTest) throw failed('INSTALLED_UPDATE_IDENTITY_MISMATCH');
    report.checks.ownedUpdatedInstallation = true;
    const io = {
      inspect: () => registry('inspect'),
      uninstall: () => { regularOwnedFile(files.uninstaller, files.installDir); if (!registry('inspect').noPlannerProcess) throw failed('APP_STILL_RUNNING'); runExecutable(files.uninstaller, ['/S']); },
      waitRemoved: () => waitForRemoval(files.executable),
      reinstall: () => { if (!removedRegistration(registry('inspect'))) throw failed('REINSTALL_OWNERSHIP_CHANGED'); regularOwnedFile(files.installer, path.join(root, 'dist')); runExecutable(files.installer, ['/S', '/D=' + files.installDir]); regularOwnedFile(files.executable, files.installDir); regularOwnedFile(files.uninstaller, files.installDir); },
      sentinel: values => registry('sentinel', values), cleanup: values => registry('cleanup', values),
    };
    await verifyLifecycle(io, files, report, crypto.randomBytes(24).toString('hex'));
    report.protocolLifecycleVerified = Object.keys(report.checks).length === 6 && Object.values(report.checks).every(Boolean);
    if (!report.protocolLifecycleVerified) throw failed('LIFECYCLE_INCOMPLETE');
    report.phase = 'complete';
  } catch (error) {
    report.reason = error.lifecycleCode || 'LIFECYCLE_CHECK_FAILED';
    process.exitCode = 1;
  }
  const output = path.resolve(__dirname, '../test-results');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'protocol-lifecycle.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`::${report.protocolLifecycleVerified ? 'notice' : 'error'} title=NSIS protocol lifecycle::` + JSON.stringify(report));
}

module.exports = { validateRunContext, updateWasVerified, ownedRegistration, ownSentinel, removedRegistration, verifyLifecycle, UPDATE_PROOF };
if (require.main === module) main();
