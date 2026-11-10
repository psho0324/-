// Real Electron integration. Run on Windows before and after NSIS installation.
// OS toast presentation/click, login/logout and cloud transport require a human PC.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.PLANNER_EXECUTABLE || require('electron');
const packaged = !!process.env.PLANNER_EXECUTABLE;
const label = process.env.PLANNER_SMOKE_LABEL || (packaged ? 'installed' : 'source');
assert(/^[a-z0-9-]+$/i.test(label), 'Invalid smoke label');
const resultsDir = path.join(root, 'test-results');
const output = path.join(resultsDir, label);
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-electron-smoke-'));
const userData = path.join(temp, 'user-data');
fs.mkdirSync(userData);
const report = {
  platform: process.platform, packaged, passed: [], failures: [], stderr: [],
  installedChecklist: {
    tray: 'Native close-to-hide and tray API are checked; actual icon appearance and tray menu clicks need manual Windows confirmation.',
    notifications: 'Not verified: Windows toast appearance, timing and click.',
    autoStart: 'Hidden launch is checked; actual next-login behavior needs manual Windows confirmation.',
    singleInstance: 'Pending integration test.',
    exitSave: 'Immediate app.quit/restart is checked; OS shutdown/logoff and visible native warning dialog need manual Windows confirmation.',
    backup: 'Real JSON-file backup IPC is checked; retention/restore also has unit coverage.',
    syncFolder: 'Not verified: real OneDrive/Google Drive transport, two PCs, disappearance/reconnection.',
    packagePaths: packaged ? 'Installed preload and icons are checked.' : 'Source preload and icon paths checked; packaged build is separate.',
    saveFailure: 'Real filesystem/IPC save failure and renderer retry are checked.'
  }
};
const annotation = message => console.error('::error title=Electron integration failed::' + String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
// Playwright can reject auxiliary launch promises before the primary launch
// rejection when Electron exits very early. Retain those errors as evidence too.
process.on('unhandledRejection', error => {
  report.failures.push({ kind: 'unhandledRejection', message: String(error?.message || error), stack: error?.stack });
  annotation(error?.stack || error?.message || error);
  process.exitCode = 1;
});
process.on('exit', () => {
  fs.writeFileSync(path.join(resultsDir, label + '.json'), JSON.stringify(report, null, 2));
});
let running;
let dataFile;
let savedBlock;
const record = name => { report.passed.push(name); console.log('PASS', name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(100); }
  throw Error(message);
}
function args(hidden = false) {
  return [...(packaged ? [] : ['.']), '--user-data-dir=' + userData, ...(hidden ? ['--hidden'] : []), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
}
async function launch(hidden = false) {
  running = await electron.launch({ executablePath: executable, cwd: root, args: args(hidden), timeout: 30000 });
  const proc = running.process();
  proc.stderr?.on('data', b => report.stderr.push(b.toString()));
  const actual = await running.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(actual).toLowerCase(), path.resolve(userData).toLowerCase(), 'Electron did not honor isolated --user-data-dir; refusing to touch a default profile');
  const page = await running.firstWindow({ timeout: 20000 });
  page.on('pageerror', error => report.failures.push({ kind: 'renderer', message: error.message, stack: error.stack }));
  await page.waitForFunction(() => window.storage && typeof window.storage.info === 'function' && document.querySelector('#homeBody')?.children.length > 0);
  const info = await page.evaluate(() => window.storage.info());
  assert(path.resolve(info.dataFile).toLowerCase().startsWith(path.resolve(userData).toLowerCase() + path.sep), 'Storage escaped isolated test directory');
  dataFile = info.dataFile;
  return page;
}
async function quit() {
  if (!running) return;
  const app = running;
  const close = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(({ app }) => app.quit()).catch(e => {
    if (!/closed|destroyed/i.test(e.message)) throw e;
  });
  await close;
  running = null;
}
async function addTodo(page, title) {
  await page.locator('[data-nav="todos"]').click();
  await page.locator('#todoNew').fill(title);
  await page.locator('#todoNew').press('Enter');
  await page.getByText(title, { exact: true }).first().waitFor();
}
(async () => {
  let page = await launch();
  const initial = await page.evaluate(() => window.storage.load());
  assert.equal(initial.todos.length, 0, 'Installed app contains sample/personal tasks');
  assert.equal(initial.events.length, 0, 'Installed app contains sample/personal events');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const prefs = await running.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0];
    globalThis.__plannerSmokePreloadErrors = [];
    w.webContents.on('preload-error', (_event, preloadPath, error) => {
      globalThis.__plannerSmokePreloadErrors.push({ path: preloadPath, message: error.message, stack: error.stack });
    });
    return { appPath: app.getAppPath(), contextIsolation: w.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: w.webContents.getLastWebPreferences().nodeIntegration };
  });
  // Electron 33 omits preload from getLastWebPreferences. Check the actual
  // application path plus IPC execution and listen for native preload failures.
  if (prefs.appPath.endsWith('.asar')) {
    assert(require('@electron/asar').extractFile(prefs.appPath, 'preload.js').length > 0, 'Installed preload.js missing from actual app archive');
  } else {
    assert(fs.existsSync(path.join(prefs.appPath, 'preload.js')), 'Actual source preload.js missing');
  }
  await page.reload();
  await page.waitForFunction(() => window.storage && typeof window.storage.info === 'function' && document.querySelector('#homeBody')?.children.length > 0);
  assert.deepEqual(await running.evaluate(() => globalThis.__plannerSmokePreloadErrors), [], 'Native preload-error event fired');
  assert(prefs.contextIsolation && !prefs.nodeIntegration);
  const icon = await running.evaluate(({ app, nativeImage }) => !nativeImage.createFromPath(app.getAppPath() + '/assets/icon.png').isEmpty());
  assert(icon, 'Packaged window/tray icon cannot be read');
  record('Real Electron window, actual preload IPC, context isolation, empty first-run data, icon path');
  await page.screenshot({ path: path.join(output, 'startup.png') });

  const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(await page.evaluate(() => window.plannerApp.getVersion()), expectedVersion);
  await page.waitForFunction(version => document.title === '내 플래너 v' + version, expectedVersion);
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#app-version').innerText(), 'v' + expectedVersion);
  await page.screenshot({ path: path.join(output, 'app-version.png') });
  record('App version from real Electron matches package metadata in settings and window title');

  // Regression: use the actual Add buttons (the old smoke only pressed Enter).
  for (const [nav, inputId, formId, errorId, key, list] of [
    ['todos', 'todoNew', 'todoAdd', 'todoAddError', 'todos', '#todoList'],
    ['goals', 'projNew', 'projAdd', 'projAddError', 'projects', '#projList'],
  ]) {
    await page.locator('[data-nav="' + nav + '"]').click();
    const before = (await page.evaluate(() => window.storage.load()))[key].length;
    for (const empty of ['', '   ']) {
      await page.locator('#' + inputId).fill(empty);
      await page.locator('#' + formId + ' button[type=submit]').click();
      assert(await page.locator('#' + errorId).isVisible());
      assert.equal(await page.evaluate(() => document.activeElement.id), inputId);
      assert.equal((await page.evaluate(() => window.storage.load()))[key].length, before);
    }
    await page.locator('#' + inputId).fill('SMOKE button ' + nav);
    assert(!(await page.locator('#' + errorId).isVisible()));
    await page.locator('#' + formId + ' button[type=submit]').click();
    await page.locator(list).getByText('SMOKE button ' + nav, { exact: true }).waitFor();
    await until(async () => (await page.evaluate(() => window.storage.load()))[key].some(x => x.title === 'SMOKE button ' + nav), 'Add button did not persist ' + nav);
  }
  record('Todo and goal Add buttons: blank/whitespace focus + warning, filled titles visible and saved');

  const categorySnapshot = JSON.stringify((await page.evaluate(() => window.storage.load())).categories);
  await page.mouse.move(1100, 100);
  assert.equal(await page.locator('.cat-edit').first().evaluate(el => getComputedStyle(el).opacity), '1');
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#set-category-list button').count(), JSON.parse(categorySnapshot).length);
  for (const cancel of ['button', 'Escape']) {
    await page.locator('#set-catNew').click();
    await page.locator('#cat-name').fill('SMOKE discard ' + cancel);
    await page.locator('#cat-colors .swatch').nth(1).click();
    await page.waitForTimeout(180);
    assert.equal(JSON.stringify((await page.evaluate(() => window.storage.load())).categories), categorySnapshot, 'Draft leaked to native storage');
    if (cancel === 'button') await page.locator('#cat-cancel').click();
    else await page.keyboard.press('Escape');
    await page.locator('#catDialog').waitFor({ state: 'hidden' });
  }
  await page.reload();
  await page.waitForFunction(() => window.storage && document.querySelector('#homeBody')?.children.length);
  assert.equal(JSON.stringify((await page.evaluate(() => window.storage.load())).categories), categorySnapshot);
  record('Visible category editing controls; draft name/color never saved after Cancel or Escape/reload');

  await page.locator('[data-nav="settings"]').click();
  await page.locator('#set-category-list button').first().click();
  const existingId = (await page.evaluate(() => window.storage.load())).categories[0].id;
  await page.locator('#cat-name').fill('SMOKE renamed');
  await page.locator('#cat-done').click();
  await until(async () => (await page.evaluate(() => window.storage.load())).categories.some(c => c.id === existingId && c.name === 'SMOKE renamed'), 'Existing category rename not saved');
  await page.locator('#set-catNew').click();
  await page.locator('#cat-name').fill('   ');
  await page.locator('#cat-done').click();
  assert(await page.locator('#catDialog').isVisible());
  assert.equal(JSON.stringify((await page.evaluate(() => window.storage.load())).categories).includes('SMOKE category'), false);
  await page.locator('#cat-name').fill('SMOKE category');
  await page.locator('#cat-done').click();
  await until(async () => (await page.evaluate(() => window.storage.load())).categories.some(c => c.name === 'SMOKE category'), 'Confirmed category missing');
  const addedId = (await page.evaluate(() => window.storage.load())).categories.find(c => c.name === 'SMOKE category').id;
  for (const [nav, inputId, catId, formId] of [
    ['todos', 'todoNew', 'todoNewCat', 'todoAdd'], ['goals', 'projNew', 'projNewCat', 'projAdd'],
  ]) {
    await page.locator('[data-nav="' + nav + '"]').click();
    await page.locator('#' + inputId).fill('SMOKE linked ' + nav);
    await page.locator('#' + catId).selectOption(addedId);
    await page.locator('#' + formId + ' button[type=submit]').click();
  }
  await page.locator('[data-nav="settings"]').click();
  await page.getByRole('button', { name: 'SMOKE category 편집·삭제', exact: true }).click();
  await page.locator('#cat-delete').click();
  await until(async () => !(await page.evaluate(() => window.storage.load())).categories.some(c => c.id === addedId), 'Category deletion not persisted');
  const afterDelete = await page.evaluate(() => window.storage.load());
  assert.equal(afterDelete.todos.find(t => t.title === 'SMOKE linked todos').categoryId, null);
  assert.equal(afterDelete.projects.find(p => p.title === 'SMOKE linked goals').categoryId, null);
  await page.locator('#toast .toast-btn').click();
  await until(async () => (await page.evaluate(() => window.storage.load())).categories.some(c => c.id === addedId), 'Category undo failed');
  const afterUndo = await page.evaluate(() => window.storage.load());
  assert.equal(afterUndo.todos.find(t => t.title === 'SMOKE linked todos').categoryId, addedId);
  assert.equal(afterUndo.projects.find(p => p.title === 'SMOKE linked goals').categoryId, addedId);
  await page.getByRole('button', { name: 'SMOKE category 편집·삭제', exact: true }).click();
  await page.locator('#cat-delete').click();
  await until(async () => !(await page.evaluate(() => window.storage.load())).categories.some(c => c.id === addedId), 'Repeated category deletion failed');
  await page.screenshot({ path: path.join(output, 'category-management.png') });
  record('Settings category rename/create/delete and undo preserve linked todo/goal data');

  // Submit inside the main process's executeJavaScript and request quit immediately
  // afterward, rather than waiting for the renderer's 100 ms debounce.
  await page.locator('[data-nav="todos"]').click();
  await page.locator('#todoNew').fill('SMOKE immediate quit task');
  const first = running;
  const closed = first.waitForEvent('close', { timeout: 15000 });
  await first.evaluate(async ({ BrowserWindow, app }) => {
    await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.querySelector("#todoAdd").requestSubmit()');
    app.quit();
  }).catch(e => { if (!/closed|destroyed/i.test(e.message)) throw e; });
  await closed; running = null;
  assert(JSON.parse(fs.readFileSync(dataFile)).todos.some(t => t.title === 'SMOKE immediate quit task'));
  page = await launch();
  const restarted = await page.evaluate(() => window.storage.load());
  assert(restarted.projects.some(p => p.title === 'SMOKE button goals'));
  assert(!restarted.categories.some(c => c.name === 'SMOKE category' || c.name.startsWith('SMOKE discard')));
  assert((await page.evaluate(() => window.storage.load())).todos.some(t => t.title === 'SMOKE immediate quit task'));
  record('Immediate UI submission → real main app.quit → persisted JSON → restart retains task');

  const backups = await page.evaluate(() => window.storage.listBackups());
  assert(backups.some(b => /^planner-\d{4}-\d{2}-\d{2}\.json$/.test(b.name)), 'Daily startup backup missing');
  const manual = await page.evaluate(() => window.storage.backupNow());
  assert(manual.length > 0);
  record('Real userData daily backup after restart and manual backup IPC');

  await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const hidden = await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1 && !BrowserWindow.getAllWindows()[0].isVisible());
  assert(hidden, 'Close did not preserve a hidden window (tray unavailable or app exited)');
  await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  record('Native window close hides without destroying; show restores same window');

  const second = spawn(executable, args(), { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let secondError = '';
  second.stderr.on('data', b => secondError += b);
  const secondExit = await Promise.race([
    new Promise((resolve, reject) => { second.once('error', reject); second.once('exit', code => resolve(code)); }),
    delay(15000).then(() => { second.kill(); throw Error('Second instance did not exit within 15s: ' + secondError); })
  ]);
  assert.equal(secondExit, 0, secondError);
  assert.equal(await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  report.installedChecklist.singleInstance = 'Verified: second real executable exits and original retains one window.';
  record('Real second process exits; original app keeps one window');

  // Real disk error, no fake storage or ipc module. Replace only this test's JSON
  // target with a directory; rename-over-directory must fail on Windows/Linux.
  await until(() => fs.existsSync(dataFile), 'No test JSON file');
  savedBlock = dataFile + '.smoke-held';
  fs.renameSync(dataFile, savedBlock);
  fs.mkdirSync(dataFile);
  await addTodo(page, 'SMOKE filesystem failure task');
  await page.locator('#saveStatus[data-state="error"]').waitFor({ state: 'visible' });
  const errorText = await page.locator('#saveStatus').innerText();
  assert(errorText.includes('저장 실패'));
  report.saveFailureMessage = { message: errorText, ipcError: await page.locator('#saveStatus').getAttribute('title') };
  await page.screenshot({ path: path.join(output, 'save-failure.png') });
  fs.rmdirSync(dataFile);
  fs.renameSync(savedBlock, dataFile); savedBlock = null;
  await page.locator('#saveStatus .save-retry').click();
  await until(() => JSON.parse(fs.readFileSync(dataFile)).todos.some(t => t.title === 'SMOKE filesystem failure task'), 'Retry did not persist after disk failure');
  record('Real filesystem rename failure travels through native IPC to visible warning, manual retry saves');
  await quit();

  page = await launch(true);
  assert.equal(await running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, '--hidden opened a visible window');
  record('Real --hidden launch creates a hidden app window');
  await quit();
  if (report.failures.length) throw Error('Renderer runtime errors were captured');
})().catch(async error => {
  report.failures.push({ message: error.message, stack: error.stack });
  annotation(error.stack || error.message);
  console.error(error.stack);
  if (running) { try { await (await running.firstWindow({ timeout: 2000 })).screenshot({ path: path.join(output, 'failure.png') }); } catch {} }
  process.exitCode = 1;
}).finally(async () => {
  if (savedBlock) {
    try { fs.rmdirSync(dataFile); fs.renameSync(savedBlock, dataFile); } catch {}
  }
  if (running) { try { await quit(); } catch { running.process()?.kill(); } }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(resultsDir, label + '.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'stderr.log'), report.stderr.join(''));
  console.log('Saved integration evidence:', output);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
