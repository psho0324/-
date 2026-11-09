// 저장소(store.js) 테스트: node test/store.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../store.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS', name); } catch (e) { console.error('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));
let clock = new Date(2026, 10, 4, 9, 0, 0);
const mk = (dir, keep) => createStore({ userDataDir: dir, now: () => clock, keep });
const sample = (n = 1) => ({ events: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, title: '일정' + i })), todos: [{ id: 't1', title: '할 일' }], projects: [], categories: [], settings: {} });

test('처음 실행: 파일이 없으면 빈 데이터', () => {
  const s = mk(tmp());
  const { data, recovered } = s.load();
  assert.deepStrictEqual(data.events, []);
  assert.strictEqual(recovered, null);
});

test('저장 → 다시 불러오기', () => {
  const dir = tmp();
  const s = mk(dir);
  s.save(sample(2));
  assert.strictEqual(mk(dir).load().data.events.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'planner-data.json.tmp')), 'tmp 파일이 남으면 안 됨');
});

test('내 저장은 "외부 변경"으로 감지되지 않음', () => {
  const s = mk(tmp());
  s.load();
  s.save(sample(1));
  assert.strictEqual(s.checkExternal(), null);
});

test('다른 곳에서 파일을 바꾸면 감지해서 새 내용을 돌려줌', () => {
  const dir = tmp();
  const a = mk(dir);
  a.load();
  a.save(sample(1));
  const b = mk(dir); // 다른 PC
  b.load();
  b.save(sample(3));
  const ext = a.checkExternal();
  assert.ok(ext && ext.events.length === 3);
  assert.strictEqual(a.checkExternal(), null, '같은 변경을 두 번 알리면 안 됨');
});

test('쓰는 중이라 깨진 파일은 무시하고 나중에 다시 확인', () => {
  const dir = tmp();
  const s = mk(dir);
  s.load();
  s.save(sample(1));
  const file = path.join(dir, 'planner-data.json');
  fs.writeFileSync(file, '{"events": [', 'utf-8');
  assert.strictEqual(s.checkExternal(), null);
  fs.writeFileSync(file, JSON.stringify(sample(4)) + ' ', 'utf-8');
  assert.strictEqual(s.checkExternal().events.length, 4);
});

test('데이터 파일이 깨졌으면 최근 백업으로 복구 + 깨진 파일은 보관', () => {
  const dir = tmp();
  const s = mk(dir);
  s.load();
  s.save(sample(2));
  s.backupIfNeeded();
  fs.writeFileSync(path.join(dir, 'planner-data.json'), '깨진 내용', 'utf-8');
  const { data, recovered } = mk(dir).load();
  assert.strictEqual(data.events.length, 2);
  assert.strictEqual(recovered, 'planner-2026-11-04.json');
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});

test('자동 백업은 하루에 한 번만', () => {
  const dir = tmp();
  const s = mk(dir);
  s.load(); s.save(sample(1));
  assert.strictEqual(s.backupIfNeeded(), 'planner-2026-11-04.json');
  s.save(sample(5));
  assert.strictEqual(s.backupIfNeeded(), null);
  assert.strictEqual(s.listBackups()[0].counts.events, 1, '그날 처음 상태가 보관됨');
  clock = new Date(2026, 10, 5, 8, 0, 0);
  assert.strictEqual(s.backupIfNeeded(), 'planner-2026-11-05.json');
  assert.deepStrictEqual(s.listBackups().map((b) => b.date), ['2026-11-05', '2026-11-04']);
  clock = new Date(2026, 10, 4, 9, 0, 0);
});

test('백업은 최근 N개만 보관', () => {
  const dir = tmp();
  const s = mk(dir, 3);
  s.load(); s.save(sample(1));
  for (let d = 1; d <= 6; d++) { clock = new Date(2026, 9, d, 9); s.backupIfNeeded(); }
  const names = s.listBackups().map((b) => b.date);
  assert.deepStrictEqual(names, ['2026-10-06', '2026-10-05', '2026-10-04']);
  clock = new Date(2026, 10, 4, 9, 0, 0);
});

test('깨진 데이터는 백업하지 않음', () => {
  const dir = tmp();
  const s = mk(dir);
  fs.writeFileSync(path.join(dir, 'planner-data.json'), '깨짐', 'utf-8');
  assert.strictEqual(s.backupIfNeeded(), null);
  assert.strictEqual(s.listBackups().length, 0);
});

test('수동 백업·복원: 복원 직전 상태도 백업됨', () => {
  const dir = tmp();
  const s = mk(dir);
  s.load(); s.save(sample(2));
  s.backupIfNeeded();
  clock = new Date(2026, 10, 4, 15, 30, 5);
  s.save(sample(7));
  const restored = s.restoreBackup('planner-2026-11-04.json');
  assert.strictEqual(restored.events.length, 2);
  assert.strictEqual(mk(dir).load().data.events.length, 2);
  const list = s.listBackups();
  assert.ok(list.some((b) => b.time === '153005' && b.counts.events === 7), '복원 전(7개) 백업이 있어야 함');
  clock = new Date(2026, 10, 4, 9, 0, 0);
});

test('복원: 이상한 이름은 거부(경로 조작 방지)', () => {
  const s = mk(tmp());
  assert.throws(() => s.restoreBackup('../planner-data.json'));
  assert.throws(() => s.restoreBackup('planner-2026-11-04.json/../../x'));
});

test('저장 폴더 바꾸기: 지금 데이터를 새 폴더로 (config에 기억)', () => {
  const home = tmp(); const cloud = tmp();
  const s = mk(home);
  s.load(); s.save(sample(2));
  const out = s.useDir(cloud, 'current', sample(2));
  assert.strictEqual(out.events.length, 2);
  assert.ok(fs.existsSync(path.join(cloud, 'planner-data.json')));
  assert.strictEqual(s.info().custom, true);
  s.save(sample(3));
  assert.strictEqual(mk(home).load().data.events.length, 3, '다시 시작해도 새 폴더를 씀');
  assert.ok(s.listBackups().length >= 1, '옮기기 전 백업');
});

test('저장 폴더 바꾸기: 그 폴더에 이미 있는 데이터를 쓰기(다른 PC 데이터)', () => {
  const home = tmp(); const cloud = tmp();
  fs.writeFileSync(path.join(cloud, 'planner-data.json'), JSON.stringify(sample(5)), 'utf-8');
  const s = mk(home);
  s.load(); s.save(sample(1));
  const out = s.useDir(cloud, 'existing', sample(1));
  assert.strictEqual(out.events.length, 5);
  assert.strictEqual(s.listBackups().find((b) => b.counts).counts.events, 1, '이 PC의 원래 데이터는 백업에 남음');
});

test('저장 폴더 바꾸기: 덮어쓰기', () => {
  const home = tmp(); const cloud = tmp();
  fs.writeFileSync(path.join(cloud, 'planner-data.json'), JSON.stringify(sample(5)), 'utf-8');
  const s = mk(home);
  s.useDir(cloud, 'current', sample(1));
  assert.strictEqual(mk(home).load().data.events.length, 1);
});

test('기본 위치로 되돌리기', () => {
  const home = tmp(); const cloud = tmp();
  const s = mk(home);
  s.useDir(cloud, 'current', sample(2));
  s.useDir(home, 'current', sample(2));
  assert.strictEqual(s.info().custom, false);
});

test('저장 폴더가 사라지면 기본 위치로 임시 복귀 + 안내', () => {
  const home = tmp(); const cloud = tmp();
  const s = mk(home);
  s.useDir(cloud, 'current', sample(1));
  fs.rmSync(cloud, { recursive: true });
  const i = s.info();
  assert.strictEqual(i.dataDir, home);
  assert.ok(i.problem && i.problem.includes('찾을 수 없어요'));
});

test('폴더가 사라졌다 돌아와도, 그동안 쓴 내용은 백업에 남음(덮여서 사라지지 않음)', () => {
  const home = tmp(); const cloud = tmp();
  const s = mk(home);
  s.useDir(cloud, 'current', sample(1)); // 동기화 폴더 사용, 일정 1개
  const cloudFile = path.join(cloud, 'planner-data.json');
  const savedCloud = fs.readFileSync(cloudFile, 'utf-8');
  fs.rmSync(cloud, { recursive: true });  // 폴더가 사라짐(로그아웃 등)
  s.save(sample(3));                       // 그 사이 편집 → 기본 위치에 저장됨
  assert.ok(fs.existsSync(path.join(home, 'planner-data.json')));
  fs.mkdirSync(cloud);                     // 폴더가 돌아옴(예전 내용이 들어 있음)
  fs.writeFileSync(cloudFile, savedCloud);
  clock = new Date(clock.getTime() + 5000);
  const ext = s.checkExternal();           // 새 위치의 (오래된) 내용을 불러오게 됨
  assert.strictEqual(ext.events.length, 1);
  const names = s.listBackups();
  const hit = names.find((b) => b.counts && b.counts.events === 3);
  assert.ok(hit, '편집 3개짜리 내용이 백업에 보관돼야 함: ' + JSON.stringify(names));
});

test('폴더 검사: 쓸 수 없는 경로는 오류', () => {
  const s = mk(tmp());
  const bad = path.join(tmp(), 'file.txt');
  fs.writeFileSync(bad, 'x');
  assert.strictEqual(s.inspectDir(path.join(bad, 'sub')).ok, false);
  assert.throws(() => s.useDir(path.join(bad, 'sub'), 'current', sample(1)));
});

console.log(`\n${passed} passed`);
