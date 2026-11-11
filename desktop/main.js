const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createStore } = require('./store.js');
const { occurrencesInRange } = require('./renderer/recurrence.js');
const { createUpdateController } = require('./updater.js');

let store = null;
let data = null;
let win = null;
let tray = null;
let updates = null;
let updateState = null;
const announcedUpdates = new Set(); // 영구 기록 실패 시에도 실행 중 중복을 막습니다.
let isQuitting = false;
let sessionEnding = false; // 윈도우 종료/로그오프 중이면 묻지 않고 바로 닫아요
let quitFlushed = false;   // 종료 전에 "저장 끝남"을 확인했는지
let quitChecking = false;  // 확인이 진행 중인지(중복 방지)
let trayTipShown = false;
// renderer 하위 프레임이나 다른 창에서 저장/설치 IPC를 호출하지 못하게 합니다.
const trustedSender = (event) => !!win && !win.isDestroyed()
  && event?.sender === win.webContents
  && event?.senderFrame === win.webContents.mainFrame;
const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
  if (!trustedSender(event)) throw new Error('앱 화면에서만 사용할 수 있는 요청이에요.');
  return listener(event, ...args);
});
const listen = (channel, listener) => ipcMain.on(channel, (event, ...args) => {
  if (trustedSender(event)) listener(event, ...args);
});
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
  if (ok === true) return true;
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: ['종료 취소', '저장하지 않고 종료'],
    defaultId: 0,
    cancelId: 0,
    title: '저장 실패',
    message: ok === null ? '저장 완료를 확인하지 못했어요.' : '마지막 변경 내용을 저장하지 못했어요.',
    detail: '화면이 응답하지 않거나 저장에 실패했을 수 있어요. 지금 종료하면 저장되지 않은 변경은 사라져요. "종료 취소"를 누르면 창으로 돌아가 "다시 시도"를 누를 수 있어요.',
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
  // 로컬 앱 화면만 허용합니다. 외부 페이지에 저장/백업 API가 노출되지 않게 합니다.
  const appUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== appUrl) event.preventDefault();
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

function refreshTray() {
  if (!tray) return;
  const menu = [{ label: '내 플래너 열기', click: showWindow }];
  if (updateState?.status === 'ready' && updates) {
    menu.push({
      label: `새 버전 v${updateState.version} 설치하고 다시 시작`,
      click: () => { void updates.install().catch(() => showWindow()); },
    });
  }
  menu.push({ type: 'separator' }, { label: '종료', click: () => { isQuitting = true; app.quit(); } });
  try { tray.setContextMenu(Menu.buildFromTemplate(menu)); }
  catch { console.error('트레이 메뉴를 갱신하지 못했어요.'); }
}

// 일정/설정 JSON과 분리한 내부 기록에는 알림을 실제 표시한 버전만 저장합니다.
function updateNoticeFile() { return path.join(app.getPath('userData'), 'planner-update-notices.json'); }
function loadUpdateNotices() {
  try {
    const value = JSON.parse(fs.readFileSync(updateNoticeFile(), 'utf8'));
    for (const version of Array.isArray(value.versions) ? value.versions : []) {
      if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) announcedUpdates.add(version);
    }
  } catch { /* 읽지 못하면 이번 실행의 Set으로 중복만 억제합니다. */ }
}
function rememberUpdateNotice(version) {
  announcedUpdates.add(version);
  try {
    const file = updateNoticeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ versions: [...announcedUpdates] }), 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch { console.error('업데이트 알림 기록을 저장하지 못했어요.'); }
}

function announceUpdate(state) {
  updateState = state;
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send('updates:state', state);
  if (state.status !== 'ready' || !state.version || announcedUpdates.has(state.version)) return;
  if (setting('notifications', true) === false || !Notification.isSupported()) return;
  announcedUpdates.add(state.version); // 표시 응답을 기다리는 동안 재진입을 억제합니다.
  let n;
  let shown = false;
  try {
    n = new Notification({
      title: '내 플래너 업데이트 준비 완료',
      body: `새 버전 v${state.version}을 받았어요. 설정이나 트레이 메뉴에서 설치하고 다시 시작할 수 있어요.`,
    });
    liveNotifications.add(n);
    n.on('click', showWindow);
    n.on('close', () => liveNotifications.delete(n));
    n.on('show', () => { shown = true; rememberUpdateNotice(state.version); });
    n.on('failed', () => {
      liveNotifications.delete(n);
      if (!shown) announcedUpdates.delete(state.version);
    });
    n.show();
  } catch {
    if (n) liveNotifications.delete(n);
    if (!shown) announcedUpdates.delete(state.version);
    console.error('업데이트 준비 알림을 표시하지 못했어요.');
  }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('내 플래너');
    refreshTray();
    tray.on('click', showWindow);
  } catch (e) {
    tray = null; // 트레이를 못 만들면 X 버튼이 그냥 종료하도록 둡니다
    console.error('트레이 생성 실패', e);
  }
}

// 저장소 생성 자체가 실패해도 앱 데이터 폴더와 복구 경로를 안내할 수 있습니다.
function startupFailure(error) {
  const userData = app.getPath('userData');
  const configFile = path.join(userData, 'planner-config.json');
  let dataDir = userData;
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (typeof cfg?.dataDir === 'string' && path.isAbsolute(cfg.dataDir) && fs.statSync(cfg.dataDir).isDirectory()) dataDir = cfg.dataDir;
  } catch { /* 손상/권한 오류인 설정은 기본 경로만 안내합니다. */ }
  const dataFile = path.join(dataDir, 'planner-data.json');
  const backupDir = path.join(userData, 'backups');
  let message = '앱을 시작하는 중 문제가 발생했어요.';
  let detail = `앱 데이터 폴더: ${userData}\n앱을 완전히 종료한 뒤 다시 실행해 주세요. 계속되면 공식 설치 파일로 다시 설치하고 앱 버전과 발생 상황을 알려 주세요. 일정 파일은 임의로 삭제하지 마세요.`;
  let folder = userData;
  if (error?.code === 'PLANNER_DATA_CORRUPT') {
    message = '저장 파일이 손상됐고 복구할 정상 백업을 찾지 못했어요.';
    detail = `원본 파일은 보존했습니다.\n저장 폴더: ${dataDir}\n원본: ${dataFile}\n손상 사본: ${dataFile}.corrupt-*\n백업 폴더: ${backupDir}\n\n앱을 닫고 원본/손상 사본을 다른 곳에 복사한 뒤, 정상 백업 JSON을 ${dataFile} 이름으로 복사하면 복구할 수 있어요. 빈 상태로 시작하려면 원본을 삭제하지 말고 이름을 바꾸세요. 이 경우 백업에 없는 내용은 화면에 나타나지 않습니다.`;
    folder = dataDir;
  } else if (error?.code === 'PLANNER_CONFIG_CORRUPT') {
    message = '저장 위치 설정 파일이 손상됐어요.';
    detail = `설정과 일정 원본은 보존했습니다.\n설정 파일: ${configFile}\n기본 데이터 폴더: ${userData}\n백업 폴더: ${backupDir}\n\n앱을 닫고 설정 파일을 다른 곳에 복사한 뒤 내용을 복구해 주세요. 파일 이름을 바꾸면 기본 위치로 시작합니다. 사용자 지정 폴더의 일정이 보이지 않으면 설정에서 원래 저장 폴더를 다시 선택하세요. 기존 일정 폴더나 백업은 삭제하지 마세요.`;
  }
  return { folder, options: { type: 'error', title: '내 플래너를 시작하지 못했어요', message, detail, buttons: ['폴더 열기', '닫기'], defaultId: 1, cancelId: 1 } };
}

// ---------- 윈도우 시작 시 자동 실행 ----------
let appliedAutoStart = null;
function applyAutoStart() {
  const want = setting('autoStart', false) === true;
  if (appliedAutoStart === want) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      path: process.execPath,
      args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--hidden'],
    });
    appliedAutoStart = want;
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
    loadUpdateNotices();

    handle('app:version', () => app.getVersion());
    const canUpdate = process.platform === 'win32' && app.isPackaged && !process.windowsStore;
    const autoUpdater = canUpdate ? require('electron-updater').autoUpdater : null;
    updates = createUpdateController({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      disabledReason: process.windowsStore ? 'store' : 'development',
      notify: announceUpdate,
      prepareInstall: async () => {
        if (quitChecking || sessionEnding || isQuitting) return 'busy';
        quitChecking = true;
        try {
          // 업데이트는 일반 종료와 달리 응답 없음도 설치를 중단합니다.
          if (await flushRenderer() !== true) { showWindow(); return 'save'; }
          try { store.backupNow(); } catch { showWindow(); return 'backup'; }
          return '';
        } finally { quitChecking = false; }
      },
      performInstall: () => {
        quitFlushed = true;
        isQuitting = true;
        autoUpdater.quitAndInstall(true, true);
      },
      installFailed: () => {
        quitFlushed = false;
        isQuitting = false;
        showWindow();
      },
    });
    updateState = updates.getState();
    handle('updates:state', () => updates.getState());
    handle('updates:check', () => updates.check());
    handle('updates:install', () => updates.install());
    app.on('will-quit', () => updates.dispose());
    handle('data:load', () => data);
    listen('app:flush-done', (_e, id, ok) => { const f = flushWaiters.get(id); if (f) f(ok === true); });
    handle('data:save', (_e, next) => {
      store.save(next);
      data = next;
      applyAutoStart();
      return true;
    });

    // --- 저장 위치 / 백업 (설정 화면에서 사용)
    handle('storage:info', () => store.info());
    handle('storage:openFolder', () => shell.openPath(store.info().dataDir));
    const requireSaved = async () => {
      if (await flushRenderer() !== true) throw new Error('최근 변경 내용을 보호하려면 먼저 저장을 완료해야 해요. 저장 실패 표시의 ‘다시 시도’를 누르고 저장 폴더의 쓰기 권한을 확인해 주세요. 필요하면 설정의 데이터 백업 내보내기로 현재 내용을 보관한 뒤 다시 시도해 주세요.');
    };
    handle('storage:chooseFolder', async () => {
      await requireSaved();
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
    handle('storage:resetFolder', async () => {
      try {
        await requireSaved();
        data = store.useDir(app.getPath('userData'), 'current', data);
      } catch (e) {
        return { error: e.message };
      }
      return { data, info: store.info() };
    });

    handle('backups:list', () => store.listBackups());
    handle('backups:now', async () => { await requireSaved(); store.backupNow(); return store.listBackups(); });
    handle('backups:restore', async (_e, name) => {
      try {
        await requireSaved();
        data = store.restoreBackup(name);
      } catch (e) {
        return { error: e.message };
      }
      appliedAutoStart = null;
      applyAutoStart();
      return { data };
    });
    handle('backups:openFolder', () => {
      const dir = store.info().backupDir;
      fs.mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    });

    createTray();
    createWindow();
    // CI 화면 검사는 정기 외부 조회만 생략하고 updater 지원/수동 경로는 유지합니다.
    if (!(process.env?.CI === 'true' && process.env?.PLANNER_DISABLE_AUTO_UPDATE === '1')) updates.start();
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
  }).catch(async (error) => {
    try {
      const failure = startupFailure(error);
      const result = await dialog.showMessageBox(failure.options);
      if (result.response === 0) {
        try { await shell.openPath(failure.folder); }
        catch { /* 안내에 표시한 경로를 수동으로 열 수 있습니다. */ }
      }
    } catch { console.error('시작 오류 안내를 표시하지 못했어요.'); }
    finally { app.exit(1); }
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
