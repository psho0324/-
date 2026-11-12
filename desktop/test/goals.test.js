const assert = require('node:assert/strict');
const G = require('../renderer/goals.js');
let tests = 0;
function test(name, run) {
  run();
  tests++;
  console.log('PASS', name);
}
const now = new Date(2026, 10, 12, 14); // Thursday, local calendar time.
const daily = { id: 'g1', title: '매일 운동', mode: 'daily', startDate: '2026-11-09', due: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6], activityId: 'exercise' };
const count = { id: 'g2', title: '이번 주 운동 3회', mode: 'count', startDate: '2026-11-09', due: null,
  period: 'week', target: 3, activityId: 'exercise' };
const record = (id, date, activityId = 'exercise') => ({ id, date, activityId, createdAt: 1794441600000 });
const options = { now, range: 'week', weekStart: 1 };
const stats = (goal, records = [], opts = {}) => G.stats(goal, records, { ...options, ...opts });

test('Daily ratio excludes future dates and unfinished today', () => {
  const s = stats(daily, [record('1', '2026-11-09'), record('2', '2026-11-11')]);
  assert.equal(s.done, 2);
  assert.equal(s.total, 3);
  assert.equal(s.pct, 67);
  assert.equal(s.unrecorded, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.days.filter((d) => d.status === 'future').length, 3);
});
test('Today completion enters the denominator; multiple records complete one daily date', () => {
  const s = stats(daily, [record('1', '2026-11-09'), record('2', '2026-11-12'), record('3', '2026-11-12')]);
  assert.equal(s.done, 2);
  assert.equal(s.total, 4);
  assert.equal(s.viewCount, 3);
  assert.equal(s.pct, 50);
});
test('Missed days differ from unrecorded days; completion takes precedence', () => {
  const days = [{ goalId: 'g1', date: '2026-11-10', status: 'missed' },
    { goalId: 'g1', date: '2026-11-11', status: 'missed' }];
  const s = stats(daily, [record('1', '2026-11-11')], { goalDays: days });
  assert.equal(s.missed, 1);
  assert.equal(s.unrecorded, 1);
  assert.equal(s.days.find((d) => d.date === '2026-11-11').status, 'done');
});
test('An explicitly missed today is respected; unrecorded today stays pending', () => {
  const s = stats(daily, [], { goalDays: [{ goalId: 'g1', date: '2026-11-12', status: 'missed' }] });
  assert.equal(s.days.find((d) => d.date === '2026-11-12').status, 'missed');
  assert.equal(s.total, 4);
  assert.equal(s.pending, 0);
});
test('Only scheduled weekdays, including Sunday, enter daily calculations', () => {
  const s = stats({ ...daily, startDate: '2026-11-01', weekdays: [0, 2, 4] },
    [record('1', '2026-11-09'), record('2', '2026-11-10')], { weekStart: 0 });
  assert.equal(s.from, '2026-11-08');
  assert.equal(s.done, 1);
  assert.equal(s.total, 2);
  assert.equal(s.viewCount, 1);
  assert.equal(s.days.find((d) => d.date === '2026-11-09').status, 'off');
});
test('Dates before the goal starts and after it ends are excluded', () => {
  const s = stats({ ...daily, startDate: '2026-11-10', due: '2026-11-11' },
    [record('1', '2026-11-09'), record('2', '2026-11-10'), record('3', '2026-11-12')]);
  assert.equal(s.done, 1);
  assert.equal(s.total, 2);
  assert.equal(s.viewCount, 1);
});
test('The two explicit goal types evaluate the same records differently', () => {
  const records = [record('1', '2026-11-10'), record('2', '2026-11-10'), record('3', '2026-11-11')];
  assert.equal(stats(daily, records).done, 2);
  assert.equal(stats(count, records).done, 3);
  assert.equal(stats(count, records).total, 3);
  assert.equal(stats(count, records).pct, 100);
  assert.equal(records.length, 3, 'Shared records are evaluated without creating copies');
});
test('Unlinked activities do not share records based on matching names', () => {
  const isolated = { ...count, activityId: 'another-activity' };
  assert.equal(stats(isolated, [record('1', '2026-11-10')]).done, 0);
});
test('Goal ID is the activity fallback when no shared activity was selected', () => {
  const isolated = { ...count };
  delete isolated.activityId;
  assert.equal(stats(isolated, [record('1', '2026-11-10', 'g2')]).done, 1);
});
test('A duplicate record ID cannot inflate an activity count', () => {
  const records = [record('same', '2026-11-10'), record('same', '2026-11-10')];
  assert.equal(stats(count, records).done, 1);
  assert.equal(G.normalizeRecords(records).length, 1);
});
test('Overachievement keeps actual counts and caps the display percentage', () => {
  const s = stats(count, Array.from({ length: 5 }, (_, i) => record(String(i), '2026-11-10')));
  assert.equal(s.done, 5);
  assert.equal(s.total, 3);
  assert.equal(s.pct, 100);
  assert.equal(s.rawPct, 167);
});
test('Monthly view does not silently change the weekly quota into a monthly quota', () => {
  const records = [record('1', '2026-11-02'), record('2', '2026-11-10')];
  const s = stats({ ...count, startDate: '2026-11-01' }, records, { range: 'month' });
  assert.equal(s.viewCount, 2);
  assert.equal(s.done, 1);
  assert.equal(s.total, 3);
  assert.equal(s.targetFrom, '2026-11-09');
  assert.equal(s.targetTo, '2026-11-15');
  assert.equal(s.targetLabel, '이번 주 목표');
  assert.equal(s.from, '2026-11-01');
  assert.equal(s.to, '2026-11-30');
});
test('Weekly view retains the monthly quota and exposes only the week activity count', () => {
  const s = stats({ ...count, period: 'month', target: 4, startDate: '2026-11-01' },
    [record('1', '2026-11-02'), record('2', '2026-11-10')]);
  assert.equal(s.viewCount, 1);
  assert.equal(s.done, 2);
  assert.equal(s.total, 4);
  assert.equal(s.targetLabel, '이번 달 목표');
  assert.equal(s.targetFrom, '2026-11-01');
  assert.equal(s.targetTo, '2026-11-30');
});
test('Future records do not count, even if a malformed import contains them', () => {
  const s = stats(count, [record('1', '2026-11-13'), record('2', '2026-12-01')]);
  assert.equal(s.done, 0);
  assert.equal(s.viewCount, 0);
});
test('A future goal has no premature failure percentage', () => {
  const s = stats({ ...count, startDate: '2026-11-14' });
  assert.equal(s.total, 0);
  assert.equal(s.pct, null);
});
test('Expired count goals have no quota in later periods', () => {
  const s = stats({ ...count, startDate: '2026-10-01', due: '2026-10-31' });
  assert.equal(s.total, 0);
  assert.equal(s.pct, null);
});
test('A goal ending inside this quota period keeps its intended target', () => {
  assert.equal(stats({ ...count, due: '2026-11-11' }).total, 3);
});
test('Leap day, year 1, and invalid calendar dates are validated strictly', () => {
  assert.equal(G.validDate('2028-02-29'), true);
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '2026-2-01', null, 20261112])
    assert.equal(G.validDate(date), false, String(date));
  assert.equal(G.validDate('0001-01-01'), true);
  assert.equal(G.validDate('0099-12-31'), true);
});
test('Month views include leap day and do not leak days into adjacent months', () => {
  const s = stats({ ...daily, startDate: '2028-02-01' }, [], { now: new Date(2028, 1, 29, 14), range: 'month' });
  assert.equal(s.days.length, 29);
  assert.equal(s.total, 28);
  assert.equal(s.from, '2028-02-01');
  assert.equal(s.to, '2028-02-29');
});
test('Daily denominators use calendar dates across daylight saving time', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const s = stats({ ...daily, startDate: '2026-03-01' }, [],
      { now: new Date(2026, 2, 9, 14), range: 'month' });
    assert.equal(s.days.length, 31);
    assert.equal(s.total, 8);
    assert.equal(s.days.filter((d) => d.date === '2026-03-08').length, 1);
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});
test('Week boundary follows the configured Sunday or Monday start', () => {
  assert.equal(stats(daily, [], { weekStart: 0 }).from, '2026-11-08');
  assert.equal(stats(daily, [], { weekStart: 1 }).from, '2026-11-09');
});
test('No eligible daily dates yields an undefined percentage instead of a fake 0%', () => {
  const s = stats({ ...daily, startDate: '2026-11-12' });
  assert.equal(s.total, 0);
  assert.equal(s.pct, null);
});
test('Malformed record and day-state containers cannot crash rendering', () => {
  assert.equal(stats(daily, {}, { goalDays: 'bad' }).done, 0);
  assert.deepEqual(G.normalizeRecords([null, {}, record('1', '2026-02-30')]), []);
  assert.deepEqual(G.normalizeDays([null, {}, { goalId: 'g1', date: '2026-11-10', status: 'done' }]), []);
});
test('Invalid schedule settings return an error without inferring success', () => {
  const s = stats({ ...daily, weekdays: [] }, [record('1', '2026-11-10')]);
  assert.match(s.error, /요일/);
  assert.equal(s.total, 0);
  assert.equal(s.done, 0);
  for (const target of [0, -1, 1.5, Infinity, 1000001]) assert.notEqual(G.validate({ ...count, target }), '');
  assert.match(G.validate({ ...daily, due: '2026-10-01' }), /종료/);
});
test('Existing one-off goals remain unchanged and are never interpreted as habits', () => {
  const original = { id: 'old', title: '자격증 취득', status: 'active', due: '2026-12-01', custom: 'keep' };
  assert.deepEqual(G.normalize(original), original);
  assert.equal(G.isRepeating(original), false);
  assert.equal(stats(original).mode, 'project');
});
test('Condition revisions preserve the previous target until the effective date', () => {
  const updated = G.revise(count, { target: 5 }, '2026-11-13');
  assert.equal(updated.target, 5);
  assert.equal(G.policyAt(updated, '2026-11-12').target, 3);
  assert.equal(G.policyAt(updated, '2026-11-13').target, 5);
  assert.equal(stats(updated).total, 3);
  assert.equal(stats(updated, [], { now: new Date(2026, 10, 13, 14) }).total, 5);
  assert.equal(count.policyHistory, undefined);
});
test('Revising weekdays does not rewrite which earlier dates were scheduled', () => {
  const updated = G.revise(daily, { weekdays: [5] }, '2026-11-13');
  const s = stats(updated, [record('1', '2026-11-09')], { now: new Date(2026, 10, 14, 14) });
  assert.equal(s.days.find((d) => d.date === '2026-11-09').status, 'done');
  assert.equal(s.days.find((d) => d.date === '2026-11-12').status, 'unrecorded');
  assert.equal(s.days.find((d) => d.date === '2026-11-13').status, 'unrecorded');
  assert.equal(s.days.find((d) => d.date === '2026-11-14').status, 'off');
});
test('Linking activities tomorrow preserves old records under the old activity', () => {
  const updated = G.revise(count, { activityId: 'new-group' }, '2026-11-13');
  const s = stats(updated, [record('1', '2026-11-10'), record('2', '2026-11-13', 'new-group'),
    record('3', '2026-11-10', 'new-group')], { now: new Date(2026, 10, 13, 14) });
  assert.equal(s.done, 2);
});
test('Repeated edits to a pending revision do not erase earlier snapshots', () => {
  const first = G.revise(count, { target: 5 }, '2026-11-13');
  const second = G.revise(first, { target: 7 }, '2026-11-13');
  assert.equal(second.policyHistory.length, 2);
  assert.equal(G.policyAt(second, '2026-11-12').target, 3);
  assert.equal(G.policyAt(second, '2026-11-13').target, 7);
  assert.throws(() => G.revise(second, { target: 9 }, '2026-11-12'), /過去|과거/);
});
test('Future-starting goals can be revised before their first practice date', () => {
  const updated = G.revise({ ...count, startDate: '2026-12-01' }, { target: 6 }, '2026-11-13');
  assert.equal(G.policyAt(updated, '2026-12-01').target, 6);
});
test('Similar title warnings remove frequency text and require overlapping periods', () => {
  assert.deepEqual(G.similarGoals(count, [daily]).map((g) => g.id), ['g1']);
  assert.equal(G.similarGoals({ ...count, startDate: '2027-01-01' }, [{ ...daily, due: '2026-12-31' }]).length, 0);
  assert.equal(G.similarGoals(count, [{ ...daily, status: 'done' }]).length, 0);
  assert.equal(G.similarGoals(daily, [daily]).length, 0);
});
test('One shared keyword does not make walking and strength training duplicates', () => {
  assert.equal(G.similarGoals({ ...count, title: '이번 주 근력 운동 3회' }, [{ ...daily, title: '매일 걷기 운동' }]).length, 0);
  assert.equal(G.titleSimilarity('매일 영어 공부', '이번 달 영어 공부 20회'), 1);
});
test('Calculations, normalization, and revisions never mutate caller data', () => {
  const goal = JSON.parse(JSON.stringify(daily));
  const records = [record('1', '2026-11-09')];
  const days = [{ goalId: 'g1', date: '2026-11-10', status: 'missed' }];
  const original = JSON.stringify({ goal, records, days });
  stats(goal, records, { goalDays: days });
  G.normalize(goal);
  G.revise(goal, { weekdays: [1] }, '2026-11-13');
  assert.equal(JSON.stringify({ goal, records, days }), original);
});
console.log(`\n${tests} goal-model tests passed`);
