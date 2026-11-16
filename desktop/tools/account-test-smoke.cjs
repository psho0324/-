// Real Linux Electron check of the private Windows build's source snapshot.
// No live authentication, user data, or Windows execution is claimed here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright');
const executable = require('electron');
const project = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || path.join(__dirname, '../test-results/account-test'));
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
assert.equal(manifest.plannerAccountTest, true);
assert.equal(manifest.name, 'my-planner-account-test');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-private-native-'));
const osConfig = path.join(temp, 'os-config');
const normalFolder = path.join(osConfig, 'my-planner');
fs.mkdirSync(normalFolder, { recursive: true });
const normalFile = path.join(normalFolder, 'planner-data.json');
const sentinel = JSON.stringify({ syntheticSentinel: 'Normal profile must stay unchanged' });
fs.writeFileSync(normalFile, sentinel);
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, XDG_CONFIG_HOME: osConfig };
const args = ['.', '--no-sandbox'];
const report = { platform: process.platform, packaged: false, windowsExecuted: false, liveSignInTested: false, passed: [], errors: [] };
let app, page;
const pass = label => { report.passed.push(label); console.log('PASS', label); };
async function launch() {
  app = await _electron.launch({ executablePath: executable, cwd: project, args, env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', e => report.errors.push(e.message));
  await page.waitForFunction(() => window.storage && document.querySelector('#homeBody')?.children.length);
}
async function quit() {
  if (!app) return;
  const current = app;
  const closed = current.waitForEvent('close', { timeout: 15000 });
  await current.evaluate(({ app }) => app.quit());
  await closed; app = null;
}
(async () => {
  assert.equal(process.platform, 'linux', 'This source test uses an isolated Linux XDG profile');
  await launch();
  const identity = await app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData'), version: app.getVersion() }));
  const profile = path.join(osConfig, 'my-planner-account-test');
  assert.equal(identity.name, 'my-planner-account-test'); assert.equal(identity.userData, profile); assert.equal(identity.version, manifest.version);
  pass('Real private app selects its dedicated default profile without a user-data-dir override');
  await page.locator('[data-nav="settings"]').click();
  const info = await page.evaluate(() => window.plannerApp.getBuildInfo());
  assert.equal(info.accountTestBuild, true); assert.equal(info.autoStartAllowed, false); assert.equal(info.autoUpdateAllowed, false);
  await page.locator('#app-build-note').waitFor({ state: 'visible' });
  assert.match(await page.title(), /계정 연결 테스트/);
  for (const id of ['set-autostart', 'set-folder', 'set-folderReset']) assert(await page.locator('#' + id).isDisabled());
  const updates = await page.evaluate(() => window.plannerApp.updates.check());
  assert.equal(updates.status, 'unsupported'); assert.equal(updates.disabledReason, 'account-test');
  pass('Native metadata and UI identify the test app and prevent public updates/startup/shared-folder changes');
  const auth = await page.evaluate(() => window.plannerAccount.getState());
  assert.equal(auth.auth.authenticated, false); assert.equal(auth.sync.connected, false);
  assert(!JSON.stringify(auth).includes('access_token')); assert(!JSON.stringify(auth).includes('refresh_token'));
  pass('Optional account stays signed out and does not expose credentials');
  await page.screenshot({ path: path.join(output, 'private-settings.png') });
  await page.locator('[data-nav="todos"]').click(); await page.locator('#todo-create').click();
  await page.locator('#td-title').fill('Synthetic private account test');
  await page.locator('#todoForm button[type=submit]').click();
  await quit(); await launch();
  const restored = await page.evaluate(() => window.storage.load());
  assert(restored.todos.some(t => t.title === 'Synthetic private account test'));
  assert.equal(fs.readFileSync(normalFile, 'utf8'), sentinel);
  pass('Actual local save/quit/relaunch retains the synthetic task and leaves the normal profile untouched');
  const child = spawn(executable, args, { cwd: project, env, stdio: 'ignore' });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Second private instance did not exit')); }, 12000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  pass('Second private process exits and the original private window remains');
  await page.evaluate(() => window.storage.backupNow());
  assert(fs.readdirSync(path.join(profile, 'backups')).some(name => name.endsWith('.json')));
  assert.equal(fs.readFileSync(normalFile, 'utf8'), sentinel);
  pass('Native backups stay inside the private profile');
  assert.deepEqual(report.errors, []);
})().catch(async error => {
  report.errors.push(error.stack || error.message); process.exitCode = 1;
  console.error(error.stack);
  if (page) try { await page.screenshot({ path: path.join(output, 'failure.png') }); } catch {}
}).finally(async () => {
  try { await quit(); } catch { if (app) try { await app.close(); } catch {} }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
});
