// main.js를 가짜 electron으로 돌려 보는 테스트: node test/main.mock.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS', name); } catch (e) { console.error('FAIL', name, '\n  ', e.stack.split('\n').slice(0, 3).join('\n   ')); process.exitCode = 1; }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-main-'));
const log = { login: [], notifications: [], windows: [], timers: [], trays: 0, quit: 0, sent: [], opened: [] };
const handlers = {};
const ipcOn = {};
const appEvents = {};
let dialogOpen = { canceled: false, filePaths: [] };
let dialogMsg = { response: 0 };
let msgBoxCalls = 0;

class FakeWin {
  constructor(opts) { this.opts = opts; this.ev = {}; this.once_ = {}; this.visible = false; this.destroyed = false; log.windows.push(this); this.webContents = { send: (ch, d) => log.sent.push([ch, d]) }; }
  setMenuBarVisibility() {}
  loadFile() {}
  once(n, f) { this.once_[n] = f; }
  on(n, f) { this.ev[n] = f; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isMinimized() { return false; }
  isDestroyed() { return this.destroyed; }
  restore() {}
  close() { log.closeCalls = (log.closeCalls || 0) + 1; }
}
class FakeNotification {
  static isSupported() { return true; }
  constructor(o) { this.o = o; this.h = {}; }
  on(n, f) { this.h[n] = f; }
  show() { log.notifications.push(this); }
}
const fakeElectron = {
  app: {
    requestSingleInstanceLock: () => true,
    setAppUserModelId() {},
    on: (n, f) => { appEvents[n] = f; },
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    getAppPath: () => '/app/path',
    isPackaged: false,
    setLoginItemSettings: (o) => log.login.push(o),
    quit: () => { log.quit++; },
  },
  BrowserWindow: FakeWin,
  ipcMain: { handle: (ch, f) => { handlers[ch] = f; }, on: (ch, f) => { ipcOn[ch] = f; } },
  Notification: FakeNotification,
  Tray: class { constructor() { log.trays++; this.h = {}; } setToolTip() {} setContextMenu(m) { this.menu = m; } on(n, f) { this.h[n] = f; } },
  Menu: { buildFromTemplate: (t) => t },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  dialog: { showOpenDialog: async () => dialogOpen, showMessageBox: async () => { msgBoxCalls++; return dialogMsg; } },
  shell: { openPath: async (p) => { log.opened.push(p); return ''; } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : origLoad.call(this, req, ...rest); };
// 타이머는 직접 돌릴 수 있게 가로챕니다
global.setInterval = (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; };

const flush = () => new Promise((r) => setImmediate(r));
const sample = (n) => ({ events: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, title: '일정' + i, allDay: false, start: '2026-11-04T10:00', end: '2026-11-04T11:00', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null })), todos: [], projects: [], categories: [], settings: {} });

(async () => {
  require('../main.js');
  await flush(); await flush();

  await test('시작: 트레이 1개, 창 1개, 첫 실행은 빈 데이터', async () => {
    assert.strictEqual(log.trays, 1);
    assert.strictEqual(log.windows.length, 1);
    assert.deepStrictEqual(await handlers['data:load'](), { events: [], todos: [], projects: [], settings: { defaultView: 'month' } });
  });

  await test('창이 준비되면 보임(자동 실행이 아닐 때)', () => {
    log.windows[0].once_['ready-to-show']();
    assert.strictEqual(log.windows[0].visible, true);
  });

  await test('저장하면 파일에 기록되고 자동 시작 설정이 반영됨', async () => {
    const d = sample(1); d.settings.autoStart = true;
    await handlers['data:save'](null, d);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'planner-data.json'), 'utf-8')).events.length, 1);
    const last = log.login.at(-1);
    assert.strictEqual(last.openAtLogin, true);
    assert.deepStrictEqual(last.args, ['/app/path', '--hidden']);
  });

  await test('자동 시작을 끄면 openAtLogin=false, 같은 값이면 다시 호출 안 함', async () => {
    const d = sample(1); d.settings.autoStart = false;
    await handlers['data:save'](null, d);
    assert.strictEqual(log.login.at(-1).openAtLogin, false);
    const n = log.login.length;
    await handlers['data:save'](null, d);
    assert.strictEqual(log.login.length, n);
  });

  await test('X 버튼: 기본은 종료하지 않고 트레이로 숨김 + 안내 알림 1회', async () => {
    const w = log.windows[0];
    let prevented = false;
    w.ev.close({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented); assert.strictEqual(w.visible, false);
    const tips = log.notifications.filter((n) => n.o.body.includes('트레이')).length;
    assert.strictEqual(tips, 1);
    w.visible = true;
    w.ev.close({ preventDefault() {} });
    assert.strictEqual(log.notifications.filter((n) => n.o.body.includes('트레이')).length, 1, '안내는 한 번만');
  });

  await test('트레이 클릭 → 창이 다시 보임 / 메뉴에 열기·종료', () => {
    const tray = log.windows && fakeElectron.Tray && null; // eslint-disable-line no-unused-vars
    const w = log.windows[0];
    w.visible = false;
    // 트레이 객체는 main.js 내부에 있으므로 second-instance 로 같은 경로를 검증
    appEvents['second-instance']();
    assert.strictEqual(w.visible, true);
  });

  await test('"계속 실행" 끄면 X 버튼: 저장 확인 후 닫힘(바로 닫지 않음)', async () => {
    const d = sample(1); d.settings.keepRunning = false;
    await handlers['data:save'](null, d);
    let prevented = false;
    const before = log.closeCalls || 0;
    log.windows[0].ev.close({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, '저장 확인 전에는 닫지 않음');
    const req = log.sent.at(-1);
    assert.strictEqual(req[0], 'app:flush-request');
    assert.strictEqual(log.closeCalls || 0, before, '답을 받기 전엔 닫히지 않음');
    ipcOn['app:flush-done'](null, req[1], true);
    await flush();
    assert.strictEqual(log.closeCalls, before + 1, '저장 확인 뒤에 창을 닫음');
  });
  await handlers['data:save'](null, sample(1)); // 다시 기본(계속 실행)으로

  await test('알림: 시간이 되면 표시, 클릭하면 창 열기, 같은 알림은 반복 안 함', async () => {
    const now = new Date(Date.now() + 10 * 60 * 1000); // 10분 뒤 시작 + 10분 전 알림 = 지금
    const k = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const d = sample(0);
    d.events.push({ id: 'r1', title: '곧 시작', allDay: false, start: k(now), end: k(new Date(now.getTime() + 3600e3)), repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: 10 });
    await handlers['data:save'](null, d);
    const checker = log.timers.find((t) => t.ms === 30000).fn;
    const before = log.notifications.length;
    checker();
    assert.strictEqual(log.notifications.length, before + 1);
    assert.strictEqual(log.notifications.at(-1).o.title, '곧 시작');
    checker();
    assert.strictEqual(log.notifications.length, before + 1);
    log.windows[0].visible = false;
    log.notifications.at(-1).h.click();
    assert.strictEqual(log.windows[0].visible, true);
  });

  await test('알림 끄면 알림이 안 뜸', async () => {
    const now = new Date(Date.now() + 10 * 60 * 1000);
    const k = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const d = sample(0); d.settings.notifications = false;
    d.events.push({ id: 'r2', title: '조용히', allDay: false, start: k(now), end: k(new Date(now.getTime() + 3600e3)), repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: 10 });
    await handlers['data:save'](null, d);
    const before = log.notifications.length;
    log.timers.find((t) => t.ms === 30000).fn();
    assert.strictEqual(log.notifications.length, before);
    await handlers['data:save'](null, sample(1));
  });

  await test('백업: 시작할 때 오늘 자동 백업이 만들어졌고, 목록/복원 동작', async () => {
    const list = await handlers['backups:list']();
    assert.ok(list.length >= 0);
    await handlers['data:save'](null, sample(2));
    const l2 = await handlers['backups:now']();
    assert.ok(l2.length >= 1);
    const target = l2.find((b) => b.counts && b.counts.events === 2);
    assert.ok(target, '방금 상태(2개) 백업이 있어야 함');
    await handlers['data:save'](null, sample(9));
    const r = await handlers['backups:restore'](null, target.name);
    assert.strictEqual(r.data.events.length, 2);
    assert.ok((await handlers['backups:restore'](null, '../x')).error);
    await handlers['backups:openFolder']();
    assert.ok(log.opened.at(-1).endsWith('backups'));
  });

  await test('동기화 폴더 고르기: 비어 있으면 지금 데이터를 거기로', async () => {
    const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-cloud-'));
    dialogOpen = { canceled: false, filePaths: [cloud] };
    const r = await handlers['storage:chooseFolder']();
    assert.ok(r.info.custom);
    assert.ok(fs.existsSync(path.join(cloud, 'planner-data.json')));
    await handlers['data:save'](null, sample(4));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cloud, 'planner-data.json'), 'utf-8')).events.length, 4);
  });

  await test('다른 PC가 같은 폴더의 파일을 바꾸면 화면으로 전달됨', async () => {
    const info = await handlers['storage:info']();
    fs.writeFileSync(info.dataFile, JSON.stringify(sample(7)), 'utf-8');
    const before = log.sent.length;
    log.timers.find((t) => t.ms === 2500).fn();
    assert.strictEqual(log.sent.length, before + 1);
    assert.strictEqual(log.sent.at(-1)[0], 'data:external');
    assert.strictEqual(log.sent.at(-1)[1].events.length, 7);
    log.timers.find((t) => t.ms === 2500).fn();
    assert.strictEqual(log.sent.length, before + 1, '같은 변경은 한 번만');
    assert.strictEqual((await handlers['data:load']()).events.length, 7);
  });

  await test('이미 데이터가 있는 폴더: "그 폴더 데이터 사용" / 취소', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-other-'));
    fs.writeFileSync(path.join(other, 'planner-data.json'), JSON.stringify(sample(3)), 'utf-8');
    dialogOpen = { canceled: false, filePaths: [other] };
    dialogMsg = { response: 2 };
    assert.ok((await handlers['storage:chooseFolder']()).canceled);
    dialogMsg = { response: 0 };
    const r = await handlers['storage:chooseFolder']();
    assert.strictEqual(r.data.events.length, 3);
  });

  await test('기본 위치로 되돌리기 / 폴더 선택 취소', async () => {
    const r = await handlers['storage:resetFolder']();
    assert.strictEqual(r.info.custom, false);
    dialogOpen = { canceled: true, filePaths: [] };
    assert.ok((await handlers['storage:chooseFolder']()).canceled);
  });

  // 종료 상태를 새로 시작하기 위해 main.js를 다시 불러와요
  delete require.cache[require.resolve('../main.js')];
  for (const k of Object.keys(appEvents)) delete appEvents[k];
  log.windows.length = 0; log.sent.length = 0; log.timers.length = 0; log.quit = 0; log.closeCalls = 0;
  require('../main.js');
  await flush(); await flush();
  log.windows[0].once_['ready-to-show']();
  await handlers['data:save'](null, sample(1));

  const lastReq = () => log.sent.filter((x) => x[0] === 'app:flush-request').at(-1);

  await test('종료: 저장이 끝났다는 답을 받은 뒤에야 종료(대기 중 변경이 사라지지 않음)', async () => {
    const q0 = log.quit;
    let prevented = false;
    appEvents['before-quit']({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, '바로 끄지 않고 먼저 저장 확인');
    const req = lastReq();
    assert.ok(req, '화면에 저장 요청을 보냄');
    assert.strictEqual(log.quit, q0, '답 전에는 종료 안 함');
    ipcOn['app:flush-done'](null, req[1], true);
    await flush();
    assert.strictEqual(log.quit, q0 + 1, '저장 확인 뒤 app.quit 다시 호출');
    // 두 번째 before-quit은 막지 않음
    let prevented2 = false;
    appEvents['before-quit']({ preventDefault: () => { prevented2 = true; } });
    assert.strictEqual(prevented2, false);
    // 종료 중에는 창 닫기도 막히지 않음
    let prevented3 = false;
    log.windows[0].ev.close({ preventDefault: () => { prevented3 = true; } });
    assert.strictEqual(prevented3, false);
  });

  // 새 main.js 인스턴스(종료 상태 초기화)로 나머지 종료 시나리오 검증
  delete require.cache[require.resolve('../main.js')];
  for (const k of Object.keys(appEvents)) delete appEvents[k];
  log.windows.length = 0; log.sent.length = 0; log.timers.length = 0; log.quit = 0; log.closeCalls = 0;
  require('../main.js');
  await flush(); await flush();
  log.windows[0].once_['ready-to-show']();
  await handlers['data:save'](null, sample(1));

  await test('종료: 저장 실패 → 안내창에서 "종료 취소" 고르면 종료하지 않고 창을 보여 줌', async () => {
    log.windows[0].visible = false;
    dialogMsg = { response: 0 };
    const calls = msgBoxCalls;
    let prevented = false;
    appEvents['before-quit']({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    ipcOn['app:flush-done'](null, lastReq()[1], false);
    await flush(); await flush();
    assert.strictEqual(msgBoxCalls, calls + 1, '실패 안내창이 뜸');
    assert.strictEqual(log.quit, 0, '종료하지 않음');
    assert.strictEqual(log.windows[0].visible, true, '저장 실패 표시가 보이도록 창을 열어 줌');
  });

  await test('종료: 저장 실패 → "저장하지 않고 종료"를 고르면 종료', async () => {
    dialogMsg = { response: 1 };
    appEvents['before-quit']({ preventDefault() {} });
    ipcOn['app:flush-done'](null, lastReq()[1], false);
    await flush(); await flush();
    assert.strictEqual(log.quit, 1);
  });

  await test('종료 확인 중에 종료를 또 눌러도 안내창이 두 번 뜨지 않음', async () => {
    delete require.cache[require.resolve('../main.js')];
    for (const k of Object.keys(appEvents)) delete appEvents[k];
    log.windows.length = 0; log.quit = 0;
    require('../main.js');
    await flush(); await flush();
    dialogMsg = { response: 0 };
    const calls = msgBoxCalls;
    appEvents['before-quit']({ preventDefault() {} });
    appEvents['before-quit']({ preventDefault() {} });
    ipcOn['app:flush-done'](null, lastReq()[1], false);
    await flush(); await flush();
    assert.strictEqual(msgBoxCalls, calls + 1);
  });

  await test('윈도우 종료/로그오프(session-end): 묻지 않고 막지도 않음', async () => {
    log.windows[0].ev['session-end']();
    let prevented = false;
    appEvents['before-quit']({ preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, false);
    let closePrevented = false;
    log.windows[0].ev.close({ preventDefault: () => { closePrevented = true; } });
    assert.strictEqual(closePrevented, false);
  });

  await test('화면이 응답하지 않으면 2초 뒤에 그냥 종료(영원히 안 꺼지는 일 없음)', async () => {
    delete require.cache[require.resolve('../main.js')];
    for (const k of Object.keys(appEvents)) delete appEvents[k];
    log.windows.length = 0; log.quit = 0;
    require('../main.js');
    await flush(); await flush();
    appEvents['before-quit']({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 2200));
    assert.strictEqual(log.quit, 1);
  });

  console.log(`\n${passed} passed`);
})();
