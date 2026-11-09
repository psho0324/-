// 저장소: 데이터 파일 읽기/쓰기, 자동 백업, 저장 폴더 변경, 다른 PC에서 바뀐 내용 감지.
// Electron 없이 Node만으로 동작하도록 분리해 두었습니다. (test/store.test.js 로 검증)
const fs = require('fs');
const path = require('path');

const DATA_NAME = 'planner-data.json';
const BACKUP_RE = /^planner-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.json$/; // 자동: 날짜만 / 수동·복원 전: 날짜-시분초
const KEEP_BACKUPS = 20;

const EMPTY = () => ({ events: [], todos: [], projects: [], settings: { defaultView: 'month' } });
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeKey = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file); // 쓰는 도중 꺼져도 파일이 깨지지 않도록
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function createStore({ userDataDir, now = () => new Date(), keep = KEEP_BACKUPS }) {
  const configFile = path.join(userDataDir, 'planner-config.json');
  const backupDir = path.join(userDataDir, 'backups'); // 백업은 항상 이 PC 안에만 둡니다(동기화 폴더를 어지럽히지 않게)
  let lastSeen = null; // 마지막으로 읽거나 쓴 데이터 파일의 상태
  let lastText = null;
  let lastFile = null; // 마지막으로 읽거나 쓴 파일 경로
  let problem = null;

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(configFile, 'utf-8')) || {}; } catch { return {}; }
  }
  function writeConfig(cfg) {
    fs.mkdirSync(userDataDir, { recursive: true });
    atomicWrite(configFile, JSON.stringify(cfg, null, 2));
  }

  function dataDir() {
    const cfg = readConfig();
    problem = null;
    if (cfg.dataDir) {
      if (isDir(cfg.dataDir)) return cfg.dataDir;
      problem = `저장 폴더를 찾을 수 없어요(${cfg.dataDir}). 임시로 기본 위치를 쓰는 중이에요.`;
    }
    return userDataDir;
  }
  const dataFile = () => path.join(dataDir(), DATA_NAME);

  function info() {
    const dir = dataDir();
    return {
      dataDir: dir,
      dataFile: path.join(dir, DATA_NAME),
      defaultDir: userDataDir,
      custom: path.resolve(dir) !== path.resolve(userDataDir),
      backupDir,
      problem,
    };
  }

  // ---------- 읽기 / 쓰기 ----------
  function remember(file, text) {
    lastFile = file;
    try {
      const st = fs.statSync(file);
      lastSeen = { mtimeMs: st.mtimeMs, size: st.size };
    } catch { lastSeen = null; }
    lastText = text;
  }

  // 반환: { data, recovered } — recovered는 파일이 깨져서 복구한 백업 이름
  function load() {
    const file = dataFile();
    let text = null;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { /* 처음 실행 */ }
    let data = null;
    let recovered = null;
    if (text != null) {
      try { data = JSON.parse(text); } catch { data = null; }
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        data = null;
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 무시 */ }
        const latest = listBackups()[0];
        if (latest) {
          try { data = readBackup(latest.name); recovered = latest.name; } catch { data = null; }
        }
      }
    }
    remember(file, text);
    return { data: { ...EMPTY(), ...(data || {}) }, recovered };
  }

  function save(data) {
    const file = dataFile();
    const text = JSON.stringify(data, null, 2);
    atomicWrite(file, text);
    remember(file, text);
  }

  // 다른 PC(동기화 폴더)나 다른 프로그램이 파일을 바꿨으면 새 내용을, 아니면 null.
  function checkExternal() {
    const file = dataFile();
    if (lastFile && file !== lastFile && lastText != null) {
      // 저장 위치가 저절로 바뀜(동기화 폴더가 잠시 사라졌다 돌아온 경우 등).
      // 그동안 다른 위치에 쓴 마지막 내용이 새 파일 내용에 덮이지 않도록 백업에 남겨 둡니다.
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const d = now();
        fs.writeFileSync(path.join(backupDir, `planner-${dateKey(d)}-${timeKey(d)}.json`), lastText);
        prune();
      } catch { /* 백업 실패는 무시 */ }
      lastFile = file;
      lastSeen = null;
    }
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (lastSeen && st.mtimeMs === lastSeen.mtimeMs && st.size === lastSeen.size) return null;
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    if (text === lastText) { lastSeen = { mtimeMs: st.mtimeMs, size: st.size }; return null; }
    let data;
    try { data = JSON.parse(text); } catch { return null; } // 아직 쓰는 중일 수 있어 다음에 다시 봅니다
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    lastSeen = { mtimeMs: st.mtimeMs, size: st.size };
    lastText = text;
    return { ...EMPTY(), ...data };
  }

  // ---------- 백업 ----------
  function parseBackupName(name) {
    const m = BACKUP_RE.exec(name);
    return m ? { date: m[1], time: m[2] || null, key: m[1] + (m[2] || '000000') } : null;
  }

  function listBackups() {
    let names = [];
    try { names = fs.readdirSync(backupDir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const p = parseBackupName(name);
      if (!p) continue;
      let size = 0;
      let counts = null;
      try {
        const file = path.join(backupDir, name);
        size = fs.statSync(file).size;
        const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
        counts = { events: (d.events || []).length, todos: (d.todos || []).length, projects: (d.projects || []).length };
      } catch { /* 읽을 수 없는 백업은 counts 없이 표시 */ }
      out.push({ name, date: p.date, time: p.time, size, counts, key: p.key });
    }
    out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    return out.map(({ key, ...rest }) => rest);
  }

  function readBackup(name) {
    if (!parseBackupName(name)) throw new Error('잘못된 백업 이름');
    const d = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf-8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('백업 내용이 올바르지 않아요');
    return d;
  }

  function prune() {
    const all = listBackups();
    for (const b of all.slice(keep)) {
      try { fs.unlinkSync(path.join(backupDir, b.name)); } catch { /* 무시 */ }
    }
  }

  function copyCurrentTo(name) {
    const file = dataFile();
    if (!fs.existsSync(file)) return null;
    try { JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } // 깨진 파일은 백업하지 않음
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, name));
    prune();
    return name;
  }

  // 오늘 자동 백업이 아직 없으면 만든다. (하루 한 번: 그날 처음 실행한 시점의 상태)
  function backupIfNeeded() {
    const name = `planner-${dateKey(now())}.json`;
    if (fs.existsSync(path.join(backupDir, name))) return null;
    return copyCurrentTo(name);
  }

  // 지금 상태를 바로 백업 (시각이 붙은 이름)
  function backupNow() {
    const d = now();
    return copyCurrentTo(`planner-${dateKey(d)}-${timeKey(d)}.json`);
  }

  function restoreBackup(name) {
    const data = readBackup(name);
    backupNow(); // 복원 직전 상태도 남겨 둡니다
    const next = { ...EMPTY(), ...data };
    save(next);
    return next;
  }

  // ---------- 저장 폴더 ----------
  function inspectDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true, hasData: fs.existsSync(path.join(dir, DATA_NAME)) };
  }

  // mode 'existing': 그 폴더에 있는 데이터를 쓴다 / 'current': 지금 데이터를 그 폴더에 저장한다
  function useDir(dir, mode, currentData) {
    const ins = inspectDir(dir);
    if (!ins.ok) throw new Error(`이 폴더에는 저장할 수 없어요: ${ins.error}`);
    backupNow(); // 위치를 바꾸기 전, 지금 위치의 데이터를 이 PC에 백업
    const cfg = readConfig();
    if (path.resolve(dir) === path.resolve(userDataDir)) delete cfg.dataDir;
    else cfg.dataDir = dir;
    writeConfig(cfg);
    lastSeen = null;
    lastText = null;
    lastFile = null;
    if (mode === 'existing' && ins.hasData) return load().data;
    save(currentData);
    return currentData;
  }

  return {
    info, load, save, checkExternal,
    listBackups, backupIfNeeded, backupNow, restoreBackup,
    inspectDir, useDir,
  };
}

module.exports = { createStore, EMPTY, DATA_NAME };
