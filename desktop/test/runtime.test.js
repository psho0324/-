// Main-process safety boundaries with fake Electron and isolated in-memory storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
function fixture({ failLoad = false, failCreate = false } = {}) {
  const handlers = {}, listeners = {}, calls = [], windows = [];
  let saveFails = false, loginFails = false;
  const initial = { events: [], todos: [], projects: [], settings: {} };
  const store = {
    load: () => { if (failLoad) throw Error('cannot read'); return { data: initial }; },
    save: () => { if (saveFails) throw Error('cannot write'); calls.push('saved'); },
    backupIfNeeded() {}, backupNow: () => calls.push('backup'), listBackups: () => [],
    useDir: () => { calls.push('changed-folder'); return initial; },
    restoreBackup: () => { calls.push('restored'); return initial; },
  };
  const app = {
    isPackaged: false, getVersion: () => '0.1.1', getPath: () => '/isolated',
    getAppPath: () => '/app', requestSingleInstanceLock: () => true,
    setAppUserModelId() {}, whenReady: () => Promise.resolve(),
    on: (key, fn) => { listeners[key] = fn; }, quit() {}, exit: code => calls.push(['exit', code]),
    setLoginItemSettings: () => { calls.push('login'); if (loginFails) { loginFails = false; throw Error('temporary API failure'); } },
  };
  class Window {
    constructor() {
      this.webContents = {
        mainFrame: {}, events: {}, send: (channel, id) => calls.push({ channel, id }),
        on: (event, fn) => { this.webContents.events[event] = fn; },
        setWindowOpenHandler: fn => { this.popup = fn; },
      }; windows.push(this);
    }
    setMenuBarVisibility() {} loadFile() {} once() {} on() {}
    isDestroyed() { return false; } isMinimized() { return false; } show() {} focus() {}
  }
  class Tray { setToolTip() {} setContextMenu() {} on() {} }
  const electron = {
    app, BrowserWindow: Window, Tray, Notification: { isSupported: () => false },
    ipcMain: { handle: (key, fn) => { handlers[key] = (event, ...args) => fn(event || { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args); }, on: (key, fn) => { handlers[key] = (event, ...args) => fn(event || { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, ...args); } },
    Menu: { buildFromTemplate: x => x }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    dialog: { showMessageBox: async () => { calls.push('error-dialog'); return { response: 0 }; } }, shell: {},
  };
  const sandbox = {
    process: { platform: 'linux', argv: [] }, __dirname: path.join(__dirname, '..'),
    console: { error() {} }, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }),
    require: name => name === 'electron' ? electron : name === './store.js'
      ? { createStore: () => { if (failCreate) throw Error('bad config'); return store; } }
      : name.startsWith('./') ? require('../' + name.slice(2)) : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), sandbox);
  return { handlers, calls, windows, initial, failSave: () => { saveFails = true; }, failLogin: () => { loginFails = true; } };
}
async function test(name, fn) { await fn(); console.log('PASS', name); passed++; }
(async () => {
  for (const option of ['failLoad', 'failCreate']) await test('Startup failure preserves data and explains why: ' + option, async () => {
    const f = fixture({ [option]: true }); await tick();
    assert(f.calls.includes('error-dialog')); assert(f.calls.some(c => Array.isArray(c) && c[0] === 'exit' && c[1] === 1));
    assert.equal(f.windows.length, 0); assert(!f.calls.includes('saved'));
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
    const f = fixture(); await tick(); const win = f.windows[0];
    let blocked = false;
    win.webContents.events['will-navigate']({ preventDefault: () => { blocked = true; } }, 'https://example.invalid');
    assert(blocked); assert.equal(win.popup({ url: 'https://example.invalid' }).action, 'deny');
  });
  for (const [channel, action] of [['backups:now', 'backup'], ['backups:restore', 'restored'], ['storage:resetFolder', 'changed-folder']]) {
    for (const answer of [false, true]) await test('Storage operation requires acknowledged save: ' + channel + ' ' + answer, async () => {
      const f = fixture(); await tick(); const promise = Promise.resolve().then(() => f.handlers[channel](null, 'fixture.json'));
      // Attach rejection handling before triggering the flush reply.
      const outcome = promise.then(value => ({ value }), error => ({ error })); await tick();
      const request = f.calls.find(c => c.channel === 'app:flush-request'); assert(request);
      assert(!f.calls.includes(action)); f.handlers['app:flush-done'](null, request.id, answer);
      const result = await outcome;
      assert.equal(f.calls.includes(action), answer);
      if (!answer) assert(result.error || result.value?.error);
    });
  }
  console.log(passed + ' runtime safety checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
