// Main-process safety boundaries with fake Electron and isolated synthetic storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../updater');
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
const fixtures = [], folders = [];
const folder = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-runtime-')); folders.push(value); return value; };
function fixture(options = {}) {
  const { failLoad = false, failCreate = false, enabled = false, notifications = true, noticeWriteFails = false, userData = folder(), env = {}, dialogResponse = 0 } = options;
  const handlers = {}, listeners = {}, calls = [], windows = [], trays = [], notices = [], dialogs = [];
  let saveFails = false, loginFails = false, controller, noticeFailures = options.noticeFailures || 0;
  const initial = { events: [], todos: [], projects: [], settings: { notifications } };
  const store = {
    load: () => { if (failLoad) throw failLoad instanceof Error ? failLoad : Error('cannot read'); return { data: initial }; },
    save: () => { if (saveFails) throw Error('cannot write'); calls.push('saved'); },
    backupIfNeeded() {}, backupNow: () => calls.push('backup'), listBackups: () => [],
    useDir: () => { calls.push('changed-folder'); return initial; },
    restoreBackup: () => { calls.push('restored'); return initial; },
  };
  const app = {
    isPackaged: enabled, getVersion: () => '0.1.1', getPath: () => userData,
    getAppPath: () => '/app', requestSingleInstanceLock: () => true,
    setAppUserModelId() {}, whenReady: () => Promise.resolve(),
    on: (key, fn) => { listeners[key] = fn; }, quit() {}, exit: code => calls.push(['exit', code]),
    setLoginItemSettings: () => { calls.push('login'); if (loginFails) { loginFails = false; throw Error('temporary API failure'); } },
  };
  class Window {
    constructor() {
      this.visible = false;
      this.webContents = {
        mainFrame: {}, events: {}, send: (channel, id) => calls.push({ channel, id }),
        on: (event, fn) => { this.webContents.events[event] = fn; },
        setWindowOpenHandler: fn => { this.popup = fn; },
      }; windows.push(this);
    }
    setMenuBarVisibility() {} loadFile() {} once() {} on() {}
    isDestroyed() { return false; } isMinimized() { return false; } show() { this.visible = true; } focus() {}
  }
  class Tray { constructor() { trays.push(this); } setToolTip() {} setContextMenu(menu) { this.menu = menu; } on() {} }
  class FakeNotification {
    static isSupported() { return true; }
    constructor(value) { this.value = value; this.events = {}; }
    on(name, fn) { this.events[name] = fn; }
    show() { notices.push(this); if (noticeFailures-- > 0) this.events.failed?.(); else this.events.show?.(); }
  }
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { calls.push('checked'); updater.emit('update-not-available'); return {}; };
  updater.quitAndInstall = (silent, restart) => calls.push({ installed: [silent, restart] });
  const electron = {
    app, BrowserWindow: Window, Tray, Notification: FakeNotification,
    ipcMain: { handle: (key, fn) => { handlers[key] = (event, ...args) => fn(event || { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args); }, on: (key, fn) => { handlers[key] = (event, ...args) => fn(event || { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args); } },
    Menu: { buildFromTemplate: x => x }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    dialog: { showMessageBox: async (...args) => { calls.push('error-dialog'); dialogs.push(args.at(-1)); return { response: dialogResponse }; } },
    shell: { openPath: async value => { calls.push({ opened: value }); return ''; } },
  };
  const sandbox = {
    process: { platform: enabled ? 'win32' : 'linux', argv: [], env }, __dirname: path.join(__dirname, '..'),
    console: { error() {} }, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }),
    require: name => name === 'electron' ? electron : name === 'electron-updater' ? { autoUpdater: updater } : name === 'fs'
      ? { ...fs, writeFileSync: (file, ...args) => { if (noticeWriteFails && file.endsWith('planner-update-notices.json.tmp')) throw Error('synthetic read-only notice file'); return fs.writeFileSync(file, ...args); } }
      : name === './store.js' ? { createStore: () => { if (failCreate) throw failCreate instanceof Error ? failCreate : Error('bad config'); return store; } }
      : name === './updater.js' ? { createUpdateController: options => { controller = createUpdateController(options); const start = controller.start; controller.start = () => { calls.push('automatic-start'); start(); }; return controller; } }
      : name.startsWith('./') ? require('../' + name.slice(2)) : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), sandbox);
  const result = { handlers, calls, windows, initial, trays, notices, dialogs, updater, userData,
    failSave: () => { saveFails = true; }, failLogin: () => { loginFails = true; }, dispose: () => controller?.dispose() };
  fixtures.push(result); return result;
}
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }
(async () => {
  for (const option of ['failLoad', 'failCreate']) await test('Startup failure preserves data and explains why: ' + option, async () => {
    const f = fixture({ [option]: true }); await tick();
    assert(f.calls.includes('error-dialog')); assert(f.calls.some(c => Array.isArray(c) && c[0] === 'exit' && c[1] === 1));
    assert.equal(f.windows.length, 0); assert(!f.calls.includes('saved'));
  });
  await test('Corrupt data, corrupt config and other startup failures have distinct recovery guidance', async () => {
    const messages = [];
    for (const code of ['PLANNER_DATA_CORRUPT', 'PLANNER_CONFIG_CORRUPT', 'MODULE_NOT_FOUND']) {
      const userData = folder(), custom = folder();
      fs.writeFileSync(path.join(userData, 'planner-config.json'), JSON.stringify({ dataDir: custom }));
      const error = Object.assign(Error('SYNTHETIC_PRIVATE_CONTENT'), { code });
      const f = fixture({ userData, failCreate: code === 'PLANNER_CONFIG_CORRUPT' ? error : false, failLoad: code !== 'PLANNER_CONFIG_CORRUPT' ? error : false }); await tick();
      const dialog = f.dialogs[0]; messages.push(dialog.message);
      assert(!JSON.stringify(dialog).includes('SYNTHETIC_PRIVATE_CONTENT')); assert.equal(dialog.defaultId, 1); assert.equal(dialog.cancelId, 1);
      assert(dialog.detail.includes(userData)); assert(f.calls.some(c => c.opened === (code === 'PLANNER_DATA_CORRUPT' ? custom : userData)));
      if (code === 'PLANNER_DATA_CORRUPT') {
        assert(dialog.detail.includes(path.join(custom, 'planner-data.json'))); assert(dialog.detail.includes('.corrupt-*'));
        assert(dialog.detail.includes(path.join(userData, 'backups'))); assert(dialog.detail.includes('이름을 바꾸세요'));
      } else if (code === 'PLANNER_CONFIG_CORRUPT') assert(dialog.detail.includes('planner-config.json'));
    }
    assert.equal(new Set(messages).size, 3);
  });
  await test('Failed disk write never becomes committed main-process data', async () => {
    const f = fixture(); await tick(); f.failSave();
    assert.throws(() => f.handlers['data:save'](null, { ...f.initial, todos: [{ id: 'unsaved' }] }));
    assert.equal(f.handlers['data:load'](), f.initial);
  });
  await test('Transient automatic-start failure retries on the next save', async () => {
    const f = fixture(); await tick(); const before = f.calls.filter(c => c === 'login').length;
    f.failLogin(); const data = { ...f.initial, settings: { autoStart: true } };
    f.handlers['data:save'](null, data); f.handlers['data:save'](null, data);
    assert.equal(f.calls.filter(c => c === 'login').length, before + 2);
  });
  await test('IPC rejects another window and renderer subframes', async () => {
    const f = fixture(); await tick(); const win = f.windows[0];
    assert.throws(() => f.handlers['data:load']({ sender: {}, senderFrame: {} }));
    assert.throws(() => f.handlers['data:save']({ sender: win.webContents, senderFrame: {} }, f.initial));
    assert(!f.calls.includes('saved'));
  });
  await test('External navigation and all new windows are denied', async () => {
    const f = fixture(); await tick(); const win = f.windows[0]; let blocked = false;
    win.webContents.events['will-navigate']({ preventDefault: () => { blocked = true; } }, 'https://example.invalid');
    assert(blocked); assert.equal(win.popup({ url: 'https://example.invalid' }).action, 'deny');
  });
  await test('Update ready notifies once per version, including across app restarts; clicking opens the window', async () => {
    const f = fixture({ enabled: true }); await tick();
    f.updater.emit('update-downloaded', { version: '0.1.2' }); f.updater.emit('update-downloaded', { version: '0.1.2' });
    assert.equal(f.notices.length, 1); assert(f.notices[0].value.body.includes('v0.1.2'));
    f.notices[0].events.click(); assert(f.windows[0].visible);
    const record = JSON.parse(fs.readFileSync(path.join(f.userData, 'planner-update-notices.json'), 'utf8'));
    assert.deepEqual(record, { versions: ['0.1.2'] }); f.dispose();
    const next = fixture({ enabled: true, userData: f.userData }); await tick();
    next.updater.emit('update-downloaded', { version: '0.1.2' }); assert.equal(next.notices.length, 0);
    next.updater.emit('update-downloaded', { version: '0.1.3' }); assert.equal(next.notices.length, 1);
  });
  await test('Disabled notifications are not displayed or marked as announced', async () => {
    const f = fixture({ enabled: true, notifications: false }); await tick();
    f.updater.emit('update-downloaded', { version: '0.1.2' }); assert.equal(f.notices.length, 0);
    assert(!fs.existsSync(path.join(f.userData, 'planner-update-notices.json')));
    assert(f.trays[0].menu.some(item => item.label?.includes('v0.1.2')));
    f.initial.settings.notifications = true; f.updater.emit('update-downloaded', { version: '0.1.2' }); assert.equal(f.notices.length, 1);
  });
  await test('Failed OS notification is not persisted and can be displayed on a later ready event', async () => {
    const f = fixture({ enabled: true, noticeFailures: 1 }); await tick();
    f.updater.emit('update-downloaded', { version: '0.1.2' });
    assert(!fs.existsSync(path.join(f.userData, 'planner-update-notices.json')));
    f.updater.emit('update-downloaded', { version: '0.1.2' });
    assert.equal(f.notices.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userData, 'planner-update-notices.json'))).versions, ['0.1.2']);
  });
  await test('Notice-record write failure keeps the app running and suppresses duplicate toasts in this execution', async () => {
    const f = fixture({ enabled: true, noticeWriteFails: true }); await tick();
    f.updater.emit('update-downloaded', { version: '0.1.2' }); f.updater.emit('update-downloaded', { version: '0.1.2' });
    assert.equal(f.notices.length, 1); assert(!f.calls.some(c => Array.isArray(c) && c[0] === 'exit'));
  });
  await test('Ready-only tray installation follows the existing save -> backup -> install route', async () => {
    const f = fixture({ enabled: true }); await tick();
    assert(!f.trays[0].menu.some(item => item.label?.includes('새 버전')));
    f.updater.emit('update-downloaded', { version: '0.1.2' });
    f.trays[0].menu.find(item => item.label?.includes('새 버전')).click(); await tick();
    assert(!f.calls.some(c => c.installed)); assert(!f.calls.includes('backup'));
    assert(!f.trays[0].menu.some(item => item.label?.includes('새 버전')));
    let request = f.calls.filter(c => c.channel === 'app:flush-request').at(-1);
    f.handlers['app:flush-done'](null, request.id, false); await tick();
    assert(!f.calls.some(c => c.installed)); assert(f.trays[0].menu.some(item => item.label?.includes('새 버전')));
    f.trays[0].menu.find(item => item.label?.includes('새 버전')).click(); await tick();
    request = f.calls.filter(c => c.channel === 'app:flush-request').at(-1); f.handlers['app:flush-done'](null, request.id, true); await tick();
    assert(f.calls.includes('backup')); assert.deepEqual(f.calls.find(c => c.installed).installed, [true, true]);
    assert(!f.trays[0].menu.some(item => item.label?.includes('새 버전'))); assert.equal(f.updater.autoInstallOnAppQuit, false);
  });
  await test('CI can omit automatic GitHub polling without making Windows updater unsupported', async () => {
    const f = fixture({ enabled: true, env: { CI: 'true', PLANNER_DISABLE_AUTO_UPDATE: '1' } }); await tick();
    assert.equal(f.handlers['updates:state']().status, 'idle'); assert(!f.calls.includes('automatic-start')); assert(!f.calls.includes('checked'));
    await f.handlers['updates:check'](); assert(f.calls.includes('checked')); assert.equal(f.handlers['updates:state']().status, 'up-to-date');
    const normal = fixture({ enabled: true, env: { PLANNER_DISABLE_AUTO_UPDATE: '1' } }); await tick(); assert(normal.calls.includes('automatic-start'));
  });
  for (const [channel, action] of [['backups:now', 'backup'], ['backups:restore', 'restored'], ['storage:resetFolder', 'changed-folder']]) {
    for (const answer of [false, true]) await test('Storage operation requires acknowledged save: ' + channel + ' ' + answer, async () => {
      const f = fixture(); await tick(); const promise = Promise.resolve().then(() => f.handlers[channel](null, 'fixture.json'));
      const outcome = promise.then(value => ({ value }), error => ({ error })); await tick();
      const request = f.calls.find(c => c.channel === 'app:flush-request'); assert(request);
      assert(!f.calls.includes(action)); f.handlers['app:flush-done'](null, request.id, answer);
      const result = await outcome;
      assert.equal(f.calls.includes(action), answer);
      if (!answer) { assert(result.error || result.value?.error); assert.match(result.error?.message || result.value.error, /최근 변경.*보호.*다시 시도.*내보내기/); }
    });
  }
  console.log(passed + ' runtime safety checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
.finally(() => { for (const f of fixtures) f.dispose(); for (const p of folders) fs.rmSync(p, { recursive: true, force: true }); });
