// 저장소: 데이터 파일 읽기/쓰기, 자동 백업, 저장 폴더 변경, 다른 PC에서 바뀐 내용 감지.
// Electron 없이 Node만으로 동작하도록 분리해 두었습니다. (test/store.test.js 로 검증)
const fs = require('fs');
const path = require('path');

const DATA_NAME = 'planner-data.json';
const BACKUP_RE = /^planner-(\d{4}-\d{2}-\d{2})(?:-(\d{6})(?:-(\d+))?)?\.json$/; // 자동: 날짜만 / 수동·복원 전: 날짜-시분초
const KEEP_BACKUPS = 20;

const EMPTY = () => ({ events: [], todos: [], projects: [], settings: { defaultView: 'month' } });
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeKey = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const isPlannerData = (value) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  ['events', 'todos', 'projects', 'categories', 'goalRecords', 'goalDays'].every(key => value[key] === undefined || Array.isArray(value[key])) &&
  (value.settings === undefined || (!!value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)));

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
    let text;
    try { text = fs.readFileSync(configFile, 'utf-8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    let cfg;
    try { cfg = JSON.parse(text); } catch { /* 아래에서 손상 설정으로 안내합니다. */ }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) ||
        (cfg.dataDir !== undefined && (typeof cfg.dataDir !== 'string' || !path.isAbsolute(cfg.dataDir)))) {
      const error = new Error('저장 위치 설정 파일이 손상되었어요. 기존 설정을 보존하고 실행을 중단합니다.');
      error.code = 'PLANNER_CONFIG_CORRUPT';
      throw error;
    }
    return cfg;
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
  function readDataFile(file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf-8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error; // 읽기 실패를 첫 실행으로 오인해 덮어쓰지 않습니다.
    }
    let data = null;
    let recovered = null;
    if (text != null) {
      try { data = JSON.parse(text); } catch { data = null; }
      if (!isPlannerData(data)) {
        data = null;
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        for (const backup of listBackups()) {
          try { data = readBackup(backup.name); recovered = backup.name; break; } catch { /* 이전의 정상 백업도 확인합니다. */ }
        }
        if (!data) {
          const error = new Error('저장 파일이 손상되었고 복구할 정상 백업이 없어요. 원본 파일은 보존했어요.');
          error.code = 'PLANNER_DATA_CORRUPT';
          throw error;
        }
      }
    }
    return { data: { ...EMPTY(), ...(data || {}) }, recovered, text };
  }

  function load() {
    const file = dataFile();
    const { data, recovered, text } = readDataFile(file);
    remember(file, text);
    return { data, recovered };
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
      const d = now();
      writeUniqueBackup(`planner-${dateKey(d)}-${timeKey(d)}.json`, lastText);
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
    if (!isPlannerData(data)) return null;
    lastSeen = { mtimeMs: st.mtimeMs, size: st.size };
    lastText = text;
    return { ...EMPTY(), ...data };
  }

  // ---------- 백업 ----------
  function parseBackupName(name) {
    const m = BACKUP_RE.exec(name);
    return m ? { date: m[1], time: m[2] || null, key: m[1] + (m[2] || '000000') + (m[3] || '0').padStart(12, '0') } : null;
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
    if (!isPlannerData(d)) throw new Error('백업 내용이 올바르지 않아요');
    return d;
  }

  function prune() {
    const all = listBackups();
    for (const b of all.slice(keep)) {
      try { fs.unlinkSync(path.join(backupDir, b.name)); } catch { /* 무시 */ }
    }
  }

  function writeUniqueBackup(name, text) {
    fs.mkdirSync(backupDir, { recursive: true });
    const stem = name.slice(0, -5);
    for (let index = 0; ; index++) {
      const candidate = index ? `${stem}-${index}.json` : name;
      try {
        fs.writeFileSync(path.join(backupDir, candidate), text, { encoding: 'utf-8', flag: 'wx' });
        prune();
        return candidate;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }

  function copyCurrentTo(name, unique = false) {
    const file = dataFile();
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf-8'); // 읽기 권한 오류는 호출자에게 알립니다.
    try { const value = JSON.parse(text); if (!isPlannerData(value)) return null; } catch { return null; } // 깨진 파일은 백업하지 않음
    if (unique) return writeUniqueBackup(name, text);
    fs.mkdirSync(backupDir, { recursive: true });
    try { fs.writeFileSync(path.join(backupDir, name), text, { encoding: 'utf-8', flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
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
    return copyCurrentTo(`planner-${dateKey(d)}-${timeKey(d)}.json`, true);
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
    const targetFile = path.join(dir, DATA_NAME);
    let next, text;
    if (mode === 'existing' && ins.hasData) {
      const loaded = readDataFile(targetFile);
      next = loaded.data; text = loaded.text;
    } else {
      next = currentData; text = JSON.stringify(next, null, 2);
      atomicWrite(targetFile, text);
    }
    // 새 위치 읽기/쓰기가 성공한 뒤 설정을 전환합니다.
    const cfg = readConfig();
    if (path.resolve(dir) === path.resolve(userDataDir)) delete cfg.dataDir;
    else cfg.dataDir = dir;
    writeConfig(cfg);
    remember(targetFile, text);
    return next;
  }

  return {
    info, load, save, checkExternal,
    listBackups, backupIfNeeded, backupNow, restoreBackup,
    inspectDir, useDir,
  };
}

module.exports = { createStore, EMPTY, DATA_NAME };
