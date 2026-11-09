const assert = require('assert');
const { occurrencesInRange, fmtDate } = require('../renderer/recurrence.js');

const D = (s) => new Date(s);
const days = (occs) => occs.map((o) => fmtDate(o.start));

// 1) 단일 일정
{
  const ev = { id: 'a', start: '2026-10-25T14:00', end: '2026-10-25T15:00', repeat: 'none' };
  assert.deepStrictEqual(days(occurrencesInRange(ev, new Date(2026, 9, 25), new Date(2026, 9, 26))), ['2026-10-25']);
  assert.strictEqual(occurrencesInRange(ev, new Date(2026, 9, 26), new Date(2026, 9, 27)).length, 0);
}

// 2) 매일 반복 + 종료일 + 예외
{
  const ev = {
    id: 'b', start: '2026-10-01T09:00', end: '2026-10-01T10:00',
    repeat: 'daily', repeatUntil: '2026-10-05', exceptions: ['2026-10-03'],
  };
  const r = days(occurrencesInRange(ev, new Date(2026, 9, 1), new Date(2026, 10, 1)));
  assert.deepStrictEqual(r, ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05']);
}

// 3) 매주(2주마다)
{
  const ev = { id: 'c', start: '2026-10-05T10:00', end: '2026-10-05T11:00', repeat: 'weekly', repeatInterval: 2 };
  const r = days(occurrencesInRange(ev, new Date(2026, 9, 1), new Date(2026, 10, 30)));
  assert.deepStrictEqual(r, ['2026-10-05', '2026-10-19', '2026-11-02', '2026-11-16', '2026-11-30'].slice(0, 4));
}

// 4) 매월 31일 → 말일 보정
{
  const ev = { id: 'd', start: '2026-01-31T09:00', end: '2026-01-31T10:00', repeat: 'monthly' };
  const r = days(occurrencesInRange(ev, new Date(2026, 0, 1), new Date(2026, 4, 1)));
  assert.deepStrictEqual(r, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
}

// 5) 매년 2/29 → 2/28 보정, 먼 미래 구간도 정상 탐색
{
  const ev = { id: 'e', start: '2024-02-29T09:00', end: '2024-02-29T10:00', repeat: 'yearly' };
  const r = days(occurrencesInRange(ev, new Date(2027, 0, 1), new Date(2029, 0, 1)));
  assert.deepStrictEqual(r, ['2027-02-28', '2028-02-29']);
}

// 6) 종일 다일 일정 (마지막 날 포함)
{
  const ev = { id: 'f', allDay: true, start: '2026-10-10', end: '2026-10-12', repeat: 'none' };
  assert.strictEqual(occurrencesInRange(ev, new Date(2026, 9, 12), new Date(2026, 9, 13)).length, 1);
  assert.strictEqual(occurrencesInRange(ev, new Date(2026, 9, 13), new Date(2026, 9, 14)).length, 0);
}

// 7) 자정을 넘기는 반복 일정이 다음 날 구간에도 걸리는지
{
  const ev = { id: 'g', start: '2026-10-01T23:00', end: '2026-10-02T01:00', repeat: 'daily' };
  const r = occurrencesInRange(ev, new Date(2026, 9, 10), new Date(2026, 9, 11));
  assert.strictEqual(r.length, 2); // 10/9 23:00 시작분 + 10/10 23:00 시작분
}

console.log('recurrence tests passed');
