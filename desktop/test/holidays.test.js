// node test/holidays.test.js — 공식 공휴일 목록과 비교
const assert = require('assert');
const H = require('../renderer/holidays.js');

const list = (year) => {
  const out = [];
  for (let d = new Date(year, 0, 1); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const k = H.key(d);
    if (H.isHoliday(k)) out.push(k.slice(5));
  }
  return out;
};
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

// 2024~2026: 인사혁신처 발표 공휴일(대체·임시 포함)과 동일해야 함
t('2024', () => assert.deepStrictEqual(list(2024), ['01-01', '02-09', '02-10', '02-11', '02-12', '03-01', '04-10', '05-05', '05-06', '05-15', '06-06', '08-15', '09-16', '09-17', '09-18', '10-01', '10-03', '10-09', '12-25']));
t('2025', () => assert.deepStrictEqual(list(2025), ['01-01', '01-27', '01-28', '01-29', '01-30', '03-01', '03-03', '05-05', '05-06', '06-03', '06-06', '08-15', '10-03', '10-05', '10-06', '10-07', '10-08', '10-09', '12-25']));
t('2026', () => assert.deepStrictEqual(list(2026), ['01-01', '02-16', '02-17', '02-18', '03-01', '03-02', '05-05', '05-24', '05-25', '06-03', '06-06', '08-15', '08-17', '09-24', '09-25', '09-26', '10-03', '10-05', '10-09', '12-25']));
t('대체공휴일 이름', () => {
  assert.strictEqual(H.name('2025-03-03'), '대체공휴일(삼일절)');
  assert.strictEqual(H.name('2025-10-08'), '대체공휴일(추석)');
  assert.strictEqual(H.name('2026-05-25'), '대체공휴일(부처님오신날)');
  assert.strictEqual(H.info('2025-03-03').sub, true);
  assert.strictEqual(H.info('2025-03-01').sub, false);
});
t('겹치는 날은 이름을 합침', () => assert.strictEqual(H.name('2025-05-05'), '어린이날·부처님오신날'));
t('2027 설날은 일요일 → 화요일 대체', () => { assert.strictEqual(H.name('2027-02-07'), '설날'); assert.ok(H.isHoliday('2027-02-09')); assert.ok(!H.isHoliday('2027-02-10')); });
t('2028 추석·개천절 겹침 → 하루만 대체(10/5)', () => { assert.strictEqual(H.name('2028-10-03'), '개천절·추석'); assert.ok(H.isHoliday('2028-10-05')); assert.ok(!H.isHoliday('2028-10-06')); });
t('2026 추석(토요일 포함)은 대체 없음', () => assert.ok(!H.isHoliday('2026-09-28')));
t('토요일 현충일·신정은 대체 없음', () => assert.ok(!H.isHoliday('2026-06-08')));
t('평일에는 표시 없음', () => assert.strictEqual(H.name('2026-11-04'), null));
t('표에 없는 해(2040)도 양력 공휴일은 표시', () => { assert.strictEqual(H.name('2040-03-01'), '삼일절'); assert.strictEqual(H.name('2040-12-25'), '성탄절'); });
t('음력 표는 2035년까지 있음', () => assert.strictEqual(H.name('2035-02-08'), '설날'));
console.log(`\n${n} passed`);
