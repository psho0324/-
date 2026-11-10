const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./store.js');
const { occurrencesInRange } = require('./renderer/recurrence.js');

let store = null;
let data = null;
let win = null;
let tray = null;
let isQuitting = false;
let sessionEnding = false; // 윈도우 종료/로그오프 중이면 묻지 않고 바로 닫아요
let quitFlushed = false;   // 종료 전에 "저장 끝남"을 확인했는지
let quitChecking = false;  // 확인이 진행 중인지(중복 방지)
let trayTipShown = false;
const startHidden = process.argv.includes('--hidden'); // 윈도우 시작 시 자동 실행이면 창 없이 트레이로만

// 설정은 화면(renderer)이 data.settings에 저장합니다.
const setting = (key, fallback) => (data && data.settings && data.settings[key] !== undefined ? data.settings[key] : fallback);
const keepRunning = () => setting('keepRunning', true) !== false; // 창을 닫아도 트레이에서 계속 실행(기본 켜짐)

// ---------- 종료 전 저장 확인 ----------
// 화면(renderer)은 바뀐 내용을 0.1초 모았다가 저장해요. 그 사이에 앱이 꺼지면 마지막 변경이 사라질 수 있어서,
// 종료·창 닫기 전에 화면에 "지금 저장해"라고 요청하고 끝났다는 답을 기다려요(최대 2초).
let flushSeq = 0;
const flushWaiters = new Map();
// true=저장됨, false=저장 실패, null=답이 없음(응답 없는 화면이면 기다리지 않고 진행)
function flushRenderer(timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.webContents) return Promise.resolve(true);
  return new Promise((resolve) => {
    const id = ++flushSeq;
    const done = (v) => { clearTimeout(timer); flushWaiters.delete(id); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    flushWaiters.set(id, (ok) => done(ok));
    try { win.webContents.send('app:flush-request', id); } catch { done(null); }
  });
}

// 종료해도 되는지: 저장이 끝났거나, 실패했어도 사용자가 "그래도 종료"를 고르면 true
async function confirmQuit() {
  const ok = await flushRenderer();
  if (ok !== false) return true;
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: ['종료 취소', '저장하지 않고 종료'],
    defaultId: 0,
    cancelId: 0,
    title: '저장 실패',
    message: '마지막 변경 내용을 저장하지 못했어요.',
    detail: '지금 종료하면 저장되지 않은 변경은 사라져요. "종료 취소"를 누르면 창으로 돌아가 "다시 시도"를 누를 수 있어요.',
  });
  return r.response === 1;
}

// ---------- 창 / 트레이 ----------
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '내 플래너',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden || tray === null) win.show(); });

  // X 버튼: 종료하지 않고 트레이로 숨겨 알림이 계속 오게 합니다.
  win.on('close', (e) => {
    if (isQuitting || sessionEnding) return;
    if (keepRunning() && tray) {
      e.preventDefault();
      win.hide();
      if (!trayTipShown && Notification.isSupported()) {
        trayTipShown = true;
        new Notification({ title: '내 플래너', body: '알림을 위해 트레이에서 계속 실행 중이에요. 완전히 끄려면 트레이 아이콘을 우클릭 → 종료.' }).show();
      }
      return;
    }
    // 트레이 없이 닫으면 종료되는 설정: 저장이 끝난 걸 확인한 뒤에 닫아요.
    e.preventDefault();
    if (quitChecking) return;
    quitChecking = true;
    confirmQuit().then((go) => {
      quitChecking = false;
      if (!go) return;
      quitFlushed = true;
      isQuitting = true;
      if (win && !win.isDestroyed()) win.close();
    });
  });
  win.on('session-end', () => { // 윈도우 종료/로그오프: 막지 않고, 보낼 수 있는 변경만 급히 보내요
    sessionEnding = true;
    isQuitting = true;
    flushRenderer(300);
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('내 플래너');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '내 플래너 열기', click: showWindow },
      { type: 'separator' },
      { label: '종료', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    tray = null; // 트레이를 못 만들면 X 버튼이 그냥 종료하도록 둡니다
    console.error('트레이 생성 실패', e);
  }
}

// ---------- 윈도우 시작 시 자동 실행 ----------
let appliedAutoStart = null;
function applyAutoStart() {
  const want = setting('autoStart', false) === true;
  if (appliedAutoStart === want) return;
  appliedAutoStart = want;
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      path: process.execPath,
      args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'],
    });
  } catch (e) {
    console.error('자동 실행 설정 실패', e);
  }
}

// ---------- 알림 스케줄러 ----------
const notified = new Set(); // "eventId|startISO|offset"
const liveNotifications = new Set(); // 클릭 전에 사라지지 않게 참조를 잡아 둡니다

function checkReminders() {
  if (!data || !Notification.isSupported()) return;
  if (setting('notifications', true) === false) return; // 설정에서 알림을 끈 경우
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 1000);
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  for (const ev of Array.isArray(data.events) ? data.events : []) {
    if (!ev || typeof ev !== 'object' || ev.reminder == null || ev.reminder < 0) continue;
    let occs = [];
    try { occs = occurrencesInRange(ev, from, to); } catch { continue; }
    for (const occ of occs) {
      const alertAt = new Date(occ.start.getTime() - ev.reminder * 60 * 1000);
      if (alertAt > now || alertAt < from) continue;
      const key = `${ev.id}|${occ.start.toISOString()}|${ev.reminder}`;
      if (notified.has(key)) continue;
      notified.add(key);
      const when = occ.start.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      const n = new Notification({
        title: ev.title || '일정',
        body: ev.allDay ? '오늘 종일 일정' : `${when} 시작` + (ev.reminder ? ` (${ev.reminder}분 전)` : ''),
      });
      liveNotifications.add(n);
      n.on('click', showWindow);
      n.on('close', () => liveNotifications.delete(n));
      n.show();
    }
  }
}

// ---------- 시작 ----------
function start() {
  app.setAppUserModelId('com.myplanner.app'); // Windows에서 알림 제목/아이콘이 제대로 보이도록
  app.on('second-instance', showWindow); // 앱을 또 실행하면 새 창 대신 기존 창을 앞으로

  app.whenReady().then(() => {
    store = createStore({ userDataDir: app.getPath('userData') });
    const loaded = store.load();
    data = loaded.data;
    if (loaded.recovered && Notification.isSupported()) {
      new Notification({ title: '내 플래너', body: `데이터 파일이 손상되어 최근 백업(${loaded.recovered})으로 복구했어요.` }).show();
    }
    try { store.backupIfNeeded(); } catch (e) { console.error('자동 백업 실패', e); }
    applyAutoStart();

    ipcMain.handle('app:version', () => app.getVersion());
    ipcMain.handle('data:load', () => data);
    ipcMain.on('app:flush-done', (_e, id, ok) => { const f = flushWaiters.get(id); if (f) f(ok === true); });
    ipcMain.handle('data:save', (_e, next) => {
      data = next;
      store.save(data);
      applyAutoStart();
      return true;
    });

    // --- 저장 위치 / 백업 (설정 화면에서 사용)
    ipcMain.handle('storage:info', () => store.info());
    ipcMain.handle('storage:openFolder', () => shell.openPath(store.info().dataDir));
    ipcMain.handle('storage:chooseFolder', async () => {
      const r = await dialog.showOpenDialog(win || undefined, {
        title: '데이터를 저장할 폴더 선택 (OneDrive·구글 드라이브·Dropbox 폴더 등)',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      const dir = r.filePaths[0];
      const ins = store.inspectDir(dir);
      if (!ins.ok) return { error: `이 폴더에는 저장할 수 없어요: ${ins.error}` };
      if (path.resolve(dir) === path.resolve(store.info().dataDir)) return { info: store.info(), same: true };
      let mode = 'current';
      if (ins.hasData) {
        const c = await dialog.showMessageBox(win || undefined, {
          type: 'question',
          buttons: ['그 폴더의 데이터 사용', '지금 데이터로 덮어쓰기', '취소'],
          defaultId: 0,
          cancelId: 2,
          title: '이미 데이터가 있어요',
          message: '선택한 폴더에 내 플래너 데이터가 이미 있어요.',
          detail: '다른 PC에서 쓰던 데이터라면 "그 폴더의 데이터 사용"을 고르세요. 이 PC의 지금 데이터는 자동으로 백업돼요.',
        });
        if (c.response === 2) return { canceled: true };
        mode = c.response === 0 ? 'existing' : 'current';
      }
      try {
        data = store.useDir(dir, mode, data);
      } catch (e) {
        return { error: e.message };
      }
      appliedAutoStart = null;
      applyAutoStart();
      return { data, info: store.info() };
    });
    ipcMain.handle('storage:resetFolder', () => {
      try {
        data = store.useDir(app.getPath('userData'), 'current', data);
      } catch (e) {
        return { error: e.message };
      }
      return { data, info: store.info() };
    });

    ipcMain.handle('backups:list', () => store.listBackups());
    ipcMain.handle('backups:now', () => { store.backupNow(); return store.listBackups(); });
    ipcMain.handle('backups:restore', (_e, name) => {
      try {
        data = store.restoreBackup(name);
      } catch (e) {
        return { error: e.message };
      }
      appliedAutoStart = null;
      applyAutoStart();
      return { data };
    });
    ipcMain.handle('backups:openFolder', () => {
      const dir = store.info().backupDir;
      fs.mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    });

    createTray();
    createWindow();
    setInterval(checkReminders, 30 * 1000);
    checkReminders();

    // 하루가 바뀌면 새 백업, 다른 PC(동기화 폴더)에서 바뀐 내용은 화면에 반영
    setInterval(() => { try { store.backupIfNeeded(); } catch (e) { console.error(e); } }, 60 * 60 * 1000);
    setInterval(() => {
      let ext = null;
      try { ext = store.checkExternal(); } catch (e) { console.error(e); }
      if (!ext) return;
      data = ext;
      appliedAutoStart = null;
      applyAutoStart();
      if (win && !win.isDestroyed()) win.webContents.send('data:external', data);
    }, 2500);

    app.on('activate', () => showWindow());
  });

  // 종료(트레이 "종료", 자동 업데이트 재시작 등): 저장이 끝난 걸 확인한 뒤에 진짜로 종료해요.
  app.on('before-quit', (e) => {
    if (quitFlushed || sessionEnding) { isQuitting = true; return; }
    e.preventDefault();
    if (quitChecking) return;
    quitChecking = true;
    confirmQuit().then((go) => {
      quitChecking = false;
      if (go) {
        quitFlushed = true;
        isQuitting = true;
        app.quit();
      } else {
        isQuitting = false; // 종료 취소: 트레이 상주로 돌아가고, 저장 실패 표시가 보이도록 창을 열어요
        showWindow();
      }
    });
  });

  // 창을 닫으면 종료하는 설정(트레이 없이)일 때만 여기로 옵니다.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (isQuitting || !keepRunning() || !tray)) app.quit();
  });
}

if (!app.requestSingleInstanceLock()) app.quit(); // 이미 실행 중이면 이 인스턴스는 바로 종료
else start();
