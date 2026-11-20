// Synthetic orchestration and destructive-operation guard tests only.
// Real registry/installer execution belongs to the Windows CI lifecycle step.
const assert = require('node:assert/strict');
const {
  validateRunContext, updateWasVerified, ownedRegistration, ownSentinel,
  removedRegistration, verifyLifecycle, UPDATE_PROOF,
} = require('../tools/check-protocol-lifecycle.cjs');

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
const context = { platform: 'win32', arch: 'x64', sourceRoot: 'D:\\a\\repo\\desktop',
  env: { CI: 'true', RUNNER_OS: 'Windows', RUNNER_TEMP: 'D:\\a\\_temp', PLANNER_EXECUTABLE: 'D:\\a\\_temp\\my-planner-installed\\MyPlanner.exe' } };
const files = validateRunContext(context);
const own = () => ({ exists: true, markerExists: true, marker: '', command: `"${files.executable}" -- "%1"`, icon: `"${files.executable}",0`, notRunning: true, noPlannerProcess: true, machineRegistrationExists: false, fixtureMarker: null });
const removed = () => ({ ...own(), exists: false, command: null, icon: null });
const proof = () => ({ baseVersion: '0.1.4', nextVersion: '0.1.5', passed: [UPDATE_PROOF], errors: [], cleanup: 'removed' });
function fixture(options = {}) {
  let snapshot = options.initial || own();
  const calls = [];
  const io = {
    inspect: () => ({ ...snapshot }),
    uninstall: () => { calls.push('uninstall'); if (!snapshot.fixtureMarker) snapshot = removed(); else if (options.removesForeign) snapshot = removed(); },
    waitRemoved: async () => { calls.push('wait-removed'); return { ...snapshot }; },
    reinstall: () => { calls.push('reinstall'); snapshot = own(); if (options.reinstallMismatch) snapshot.command = 'foreign'; },
    sentinel: ({ expected, command, marker }) => {
      calls.push('sentinel'); assert.equal(snapshot.command, expected);
      if (options.failureBeforeMutation) throw Error('SYNTHETIC_WORKER_FAILURE');
      snapshot.command = command; snapshot.fixtureMarker = marker;
      if (options.ownershipChanges) snapshot.fixtureMarker = 'other';
      if (options.failureAfterMutation) throw Error('SYNTHETIC_WORKER_FAILURE');
    },
    cleanup: ({ command, marker }) => { calls.push('cleanup'); assert(ownSentinel(snapshot, command, marker)); snapshot = removed(); },
  };
  return { io, calls, report: { checks: {} }, snapshot: () => snapshot };
}

(async () => {
  await test('Exact Windows CI fixture resolves only its owned executable and installers', () => {
    assert.equal(files.installDir, 'D:\\a\\_temp\\my-planner-installed');
    assert.equal(files.uninstaller, 'D:\\a\\_temp\\my-planner-installed\\Uninstall MyPlanner.exe');
    assert.equal(files.installer, 'D:\\a\\repo\\desktop\\dist\\MyPlanner-Setup.exe');
    assert.equal(validateRunContext({ ...context, env: { ...context.env, PLANNER_EXECUTABLE: context.env.PLANNER_EXECUTABLE.toUpperCase() } }).executable, files.executable);
  });
  await test('Non-Windows, non-CI, wrong architecture and foreign or network paths cannot reach destructive operations', () => {
    for (const changed of [{ platform: 'linux' }, { arch: 'arm64' }, { sourceRoot: 'relative' }, { sourceRoot: '\\\\server\\share\\desktop' },
      ...[{ CI: 'false' }, { RUNNER_OS: 'Linux' }, { RUNNER_TEMP: '' }, { RUNNER_TEMP: 'relative' }, { RUNNER_TEMP: '\\\\server\\share' },
        { PLANNER_EXECUTABLE: '' }, { PLANNER_EXECUTABLE: 'C:\\Users\\Person\\MyPlanner.exe' },
        { PLANNER_EXECUTABLE: 'D:\\a\\_temp\\another-installed\\MyPlanner.exe' }].map(env => ({ env: { ...context.env, ...env } }))]) {
      assert.throws(() => validateRunContext({ ...context, ...changed }), /OWNED_CI_REQUIRED/);
    }
  });
  await test('Update evidence needs exact versions, a passed preservation scenario, no errors and owned cleanup evidence', () => {
    assert(updateWasVerified(proof(), '0.1.4', '0.1.5'));
    for (const changed of [{ baseVersion: '0.1.3' }, { nextVersion: '0.1.4' }, { passed: [] }, { errors: ['failure'] }, { errors: null }, { cleanup: null }, { cleanup: { code: 'EIO' } }]) {
      assert(!updateWasVerified({ ...proof(), ...changed }, '0.1.4', '0.1.5'));
    }
    assert(!updateWasVerified({}, '0.1.4', '0.1.5'));
    assert(!updateWasVerified(null, '0.1.4', '0.1.5'));
    assert(!updateWasVerified({ ...proof(), nextVersion: '0.1.4' }, '0.1.4', '0.1.4'));
  });
  await test('Post-update registration rejects running apps, machine handlers, wrong commands and malformed URL markers', () => {
    assert(ownedRegistration(own(), files.executable));
    for (const changed of [{ noPlannerProcess: false }, { notRunning: false }, { machineRegistrationExists: true },
      { command: 'foreign' }, { command: `"${files.executable}" "%1"` }, { marker: null }, { exists: false }, { markerExists: false }]) {
      assert(!ownedRegistration({ ...own(), ...changed }, files.executable));
    }
  });
  await test('An absent key alone is insufficient when an app or machine handler remains', () => {
    assert(removedRegistration(removed()));
    for (const changed of [{ exists: true }, { noPlannerProcess: false }, { machineRegistrationExists: true }]) assert(!removedRegistration({ ...removed(), ...changed }));
  });
  await test('Cleanup requires both exact sentinel command and unpredictable marker ownership', () => {
    const snapshot = { ...own(), command: files.sentinelCommand, fixtureMarker: 'owned' };
    assert(ownSentinel(snapshot, files.sentinelCommand, 'owned'));
    for (const changed of [{ command: 'other' }, { fixtureMarker: 'other' }, { exists: false }, { noPlannerProcess: false }, { machineRegistrationExists: true }, { marker: null }]) assert(!ownSentinel({ ...snapshot, ...changed }, files.sentinelCommand, 'owned'));
  });
  await test('Full lifecycle verifies updated registration, actual removal, reinstall and foreign preservation before exact cleanup', async () => {
    const f = fixture(); await verifyLifecycle(f.io, files, f.report, 'owned');
    assert.deepEqual(f.calls, ['uninstall', 'wait-removed', 'reinstall', 'sentinel', 'uninstall', 'wait-removed', 'cleanup']);
    assert.deepEqual(f.report.checks, { postUpdateRegistration: true, ownUninstallRemovesRegistration: true, reinstallRegistration: true, otherOwnerPreserved: true, sentinelCleanup: true });
    assert(removedRegistration(f.snapshot()));
    assert(!JSON.stringify(f.report).includes(files.executable));
  });
  await test('An unexpected post-update owner causes zero uninstalls, reinstalls, registry mutations or cleanup', async () => {
    const f = fixture({ initial: { ...own(), command: 'other' } });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /POST_UPDATE_REGISTRATION_MISMATCH/);
    assert.deepEqual(f.calls, []);
  });
  await test('Reinstall mismatch stops before changing the registry or running a second uninstall', async () => {
    const f = fixture({ reinstallMismatch: true });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /REINSTALL_REGISTRATION_MISMATCH/);
    assert.deepEqual(f.calls, ['uninstall', 'wait-removed', 'reinstall']);
  });
  await test('A sentinel owner change is never removed even during failure cleanup', async () => {
    const f = fixture({ ownershipChanges: true });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /SENTINEL_NOT_CONFIRMED/);
    assert.equal(f.report.cleanupReason, 'SENTINEL_OWNERSHIP_CHANGED');
    assert(!f.calls.includes('cleanup'));
    assert.equal(f.calls.filter(call => call === 'uninstall').length, 1);
  });
  await test('A worker failure before mutation preserves the original handler without cleanup writes', async () => {
    const f = fixture({ failureBeforeMutation: true });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /SYNTHETIC_WORKER_FAILURE/);
    assert(ownedRegistration(f.snapshot(), files.executable));
    assert(!f.calls.includes('cleanup'));
    assert.equal(f.report.checks.sentinelCleanup, true);
  });
  await test('A worker failure after mutation still cleans only its exact sentinel and preserves the original failure', async () => {
    const f = fixture({ failureAfterMutation: true });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /SYNTHETIC_WORKER_FAILURE/);
    assert(removedRegistration(f.snapshot()));
    assert(f.calls.includes('cleanup'));
    assert.equal(f.report.checks.sentinelCleanup, true);
  });
  await test('Uninstaller removal of another owner is reported as failure and never becomes a pass', async () => {
    const f = fixture({ removesForeign: true });
    await assert.rejects(verifyLifecycle(f.io, files, f.report, 'owned'), /FOREIGN_REGISTRATION_NOT_PRESERVED/);
    assert.equal(f.report.cleanupReason, 'SENTINEL_OWNERSHIP_CHANGED');
    assert(!f.report.checks.otherOwnerPreserved);
    assert(!f.calls.includes('cleanup'));
  });
  console.log(`${passed} protocol lifecycle checks passed; synthetic orchestration only, no registry or installer execution`);
})().catch(error => { console.error(error); process.exitCode = 1; });
