// 한국 공휴일 (공휴일 + 대체공휴일 + 임시공휴일). 화면에서 읽기만 하며 일정 데이터에는 섞이지 않아요.
// - 양력 공휴일은 모든 해에 적용하고, 음력 명절(설날·부처님오신날·추석)은 아래 표가 있는 2024~2035년만 표시해요.
// - 임시공휴일(선거일 등)은 정부 발표로 생기므로 TEMPORARY 표에 직접 추가해야 해요.
(function (root) {
  // 음력 명절의 양력 날짜 (한국 표준시 기준 삭(朔) 계산으로 확인)
  const LUNAR = {
    2024: { seol: '2024-02-10', buddha: '2024-05-15', chuseok: '2024-09-17' },
    2025: { seol: '2025-01-29', buddha: '2025-05-05', chuseok: '2025-10-06' },
    2026: { seol: '2026-02-17', buddha: '2026-05-24', chuseok: '2026-09-25' },
    2027: { seol: '2027-02-07', buddha: '2027-05-13', chuseok: '2027-09-15' },
    2028: { seol: '2028-01-27', buddha: '2028-05-02', chuseok: '2028-10-03' },
    2029: { seol: '2029-02-13', buddha: '2029-05-20', chuseok: '2029-09-22' },
    2030: { seol: '2030-02-03', buddha: '2030-05-09', chuseok: '2030-09-12' },
    2031: { seol: '2031-01-23', buddha: '2031-05-28', chuseok: '2031-10-01' },
    2032: { seol: '2032-02-11', buddha: '2032-05-16', chuseok: '2032-09-19' },
    2033: { seol: '2033-01-31', buddha: '2033-05-06', chuseok: '2033-09-08' },
    2034: { seol: '2034-02-19', buddha: '2034-05-25', chuseok: '2034-09-27' },
    2035: { seol: '2035-02-08', buddha: '2035-05-15', chuseok: '2035-09-16' },
  };

  // 임시공휴일 / 선거일 (발표될 때마다 여기에 추가)
  const TEMPORARY = {
    '2024-04-10': '국회의원선거',
    '2024-10-01': '국군의 날(임시공휴일)',
    '2025-01-27': '임시공휴일',
    '2025-06-03': '대통령선거',
    '2026-06-03': '지방선거',
  };

  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const shift = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return key(d); };
  const dow = (k) => parse(k).getDay();

  const cache = new Map();

  function build(year) {
    const map = {}; // 날짜 → [{ name, sub }]
    const add = (k, name, sub = false) => { (map[k] ||= []).push({ name, sub }); };

    // 묶음(group): 같이 쉬는 날들. rule: 'weekend'(토·일 겹치면 대체) | 'sunday'(일요일만, 설·추석) | 'none'
    const groups = [];
    const solar = (m, d, name, rule) => groups.push({ days: [`${year}-${pad(m)}-${pad(d)}`], name, rule });
    solar(1, 1, '신정', 'none');
    solar(3, 1, '삼일절', 'weekend');
    solar(5, 5, '어린이날', 'weekend');
    solar(6, 6, '현충일', 'none');
    solar(8, 15, '광복절', 'weekend');
    solar(10, 3, '개천절', 'weekend');
    solar(10, 9, '한글날', 'weekend');
    solar(12, 25, '성탄절', 'weekend');

    const L = LUNAR[year];
    if (L) {
      groups.push({ days: [shift(L.seol, -1), L.seol, shift(L.seol, 1)], names: ['설날 연휴', '설날', '설날 연휴'], rule: 'sunday', label: '설날' });
      groups.push({ days: [L.buddha], name: '부처님오신날', rule: 'weekend' });
      groups.push({ days: [shift(L.chuseok, -1), L.chuseok, shift(L.chuseok, 1)], names: ['추석 연휴', '추석', '추석 연휴'], rule: 'sunday', label: '추석' });
    }
    for (const g of groups) g.days.forEach((k, i) => add(k, g.names ? g.names[i] : g.name));
    for (const [k, name] of Object.entries(TEMPORARY)) if (k.startsWith(`${year}-`)) add(k, name);

    // 대체공휴일: 겹치는 날 하나마다 하루씩, 묶음이 끝난 다음 첫 평일(공휴일 아닌 날)에 배정
    const used = new Set();
    groups.sort((a, b) => (a.days[0] < b.days[0] ? -1 : a.days[0] > b.days[0] ? 1 : 0));
    for (const g of groups) {
      if (g.rule === 'none') continue;
      let count = 0;
      for (const k of g.days) {
        if (used.has(k)) continue;
        const w = dow(k);
        const weekend = g.rule === 'sunday' ? w === 0 : (w === 0 || w === 6);
        if (weekend || map[k].length > 1) { count++; used.add(k); }
      }
      let k = g.days[g.days.length - 1];
      for (let i = 0; i < count; i++) {
        do { k = shift(k, 1); } while (dow(k) === 0 || dow(k) === 6 || map[k]);
        add(k, `대체공휴일(${g.label || g.name})`, true);
      }
    }
    return map;
  }

  function info(k) {
    const year = Number(k.slice(0, 4));
    if (!cache.has(year)) cache.set(year, build(year));
    const list = cache.get(year)[k];
    if (!list) return null;
    // 겹치면 이름을 ·로 이어서(예: 어린이날·부처님오신날) 하나의 표시로
    return { name: list.map((x) => x.name).join('·'), sub: list.every((x) => x.sub) };
  }

  const api = { info, name: (k) => (info(k) || {}).name || null, isHoliday: (k) => !!info(k), key, LUNAR_YEARS: Object.keys(LUNAR).map(Number) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Holidays = api;
})(typeof window !== 'undefined' ? window : globalThis);
