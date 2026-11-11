// node test/quickadd.test.js
const assert = require('assert');
const { parse } = require('../renderer/quickadd.js');
// 기준 시각: 2026-11-04(수) 14:00
const NOW = new Date(2026, 10, 4, 14, 0);
const cats = [{ id: 'c1', name: '업무' }, { id: 'c2', name: '운동' }, { id: 'c3', name: '개인' }];
let n = 0;
const t = (input, exp) => {
  const r = parse(input, NOW, cats);
  for (const [k, v] of Object.entries(exp)) assert.strictEqual(r[k], v, `"${input}" → ${k}: ${r[k]} (기대 ${v})`);
  n++;
  console.log('PASS ' + input);
};

t('내일 오후 3시 치과', { kind: 'event', title: '치과', start: '2026-11-05T15:00', end: '2026-11-05T16:00' });
t('내일 3시 치과', { kind: 'event', start: '2026-11-05T15:00' });                // 말머리 없으면 3시=오후
t('내일 오전 9시 반 회의 2시간', { kind: 'event', title: '회의', start: '2026-11-05T09:30', end: '2026-11-05T11:30' });
t('오늘 7시 운동 #운동', { kind: 'event', title: '운동', categoryId: 'c2', start: '2026-11-04T07:00' }); // 7시=오전
t('모레 14:30 면접', { kind: 'event', title: '면접', start: '2026-11-06T14:30', end: '2026-11-06T15:30' });
t('금요일 오후 2시부터 4시까지 스터디', { kind: 'event', title: '스터디', start: '2026-11-06T14:00', end: '2026-11-06T16:00' });
t('11/20 종일 출장', { kind: 'event', allDay: true, title: '출장', start: '2026-11-20', end: '2026-11-20' });
t('다음주 월요일 10시 주간회의 30분', { kind: 'event', title: '주간회의', start: '2026-11-09T10:00', end: '2026-11-09T10:30' });
t('12월 25일 저녁 7시 파티', { kind: 'event', title: '파티', start: '2026-12-25T19:00' });
t('1월 5일 점심 약속', { kind: 'todo', date: '2027-01-05', title: '점심 약속' });   // 지난 날짜는 내년으로
t('3일 뒤 오후 1시 병원 1.5시간', { kind: 'event', title: '병원', start: '2026-11-07T13:00', end: '2026-11-07T14:30' });
t('내일 장보기', { kind: 'todo', date: '2026-11-05', title: '장보기' });
t('보고서 쓰기 ! #업무', { kind: 'todo', date: null, title: '보고서 쓰기', priority: 2, categoryId: 'c1' });
t('할 일: 내일 오후 3시 전화하기', { kind: 'todo', date: '2026-11-05', title: '전화하기' });
t('일정: 영어 스터디', { kind: 'event', title: '영어 스터디', allDay: true, date: '2026-11-04' });
t('2026-12-01 오전 10시 계약', { kind: 'event', start: '2026-12-01T10:00', title: '계약' });
t('다다음주 수요일 종일 워크숍', { kind: 'event', allDay: true, date: '2026-11-18', title: '워크숍' });
t('오후 3시에 치과', { kind: 'event', title: '치과', start: '2026-11-04T15:00' });   // 날짜 없으면 오늘
t('10일 병원 예약', { kind: 'todo', date: '2026-11-10', title: '병원 예약' });
t('3.5시간 작업', { kind: 'todo', title: '작업' });                                       // 길이만 있고 시각 없음 → 할 일
t('', { empty: true });
for (const text of ['2026-02-30 오후 3시 회의','13월 2일 회의','2월 30일 회의','15:99 회의','오후 15시 회의','24:01 회의','이번달 31일 회의']) {
  const result=parse(text,NOW,cats);
  assert.strictEqual(result.invalid,true,text);
  assert.strictEqual(result.title,text,'잘못된 입력 원문은 보존');
  n++;
}
t('2월 29일 여행', { date:'2028-02-29', title:'여행' });
t('31일 회의', { date:'2026-12-31', title:'회의' });
t('24:00 자정', { start:'2026-11-05T00:00',title:'자정' });
console.log(`\n${n} passed`);
