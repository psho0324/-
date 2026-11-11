// 빠른 입력: "내일 오후 3시 치과 1시간 #업무" 같은 한 줄을 일정/할 일로 바꿉니다.
// parse(text, now, categories) → { kind: 'event'|'todo', title, date, allDay, start, end, categoryId, priority, empty }
//   event: date(YYYY-MM-DD), start/end("YYYY-MM-DDTHH:mm") 또는 종일이면 start=end=date
//   todo : date(마감일, 없으면 null)
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const DOW = '일월화수목금토';
  const MER = '(오전|오후|아침|점심|저녁|밤|새벽)';

  // 시(1~12 또는 24시간)와 오전/오후 말머리로 하루 중 분(minute)을 정합니다.
  function toMinutes(h, mer, min, ref) {
    let hh = h;
    if (mer === '오후' || mer === '저녁' || mer === '밤') { if (hh < 12) hh += 12; }
    else if (mer === '점심') { if (hh < 11) hh += 12; }
    else if (mer === '오전' || mer === '아침' || mer === '새벽') { if (hh === 12) hh = 0; }
    else if (hh >= 1 && hh <= 6) hh += 12; // 말머리가 없으면 1~6시는 오후로 봄
    else if (ref != null && hh < 12 && hh * 60 + min <= ref) hh += 12; // 끝 시각이 시작보다 앞서면 오후로
    return hh * 60 + min;
  }

  function parse(input, now = new Date(), cats = []) {
    let rest = ` ${String(input || '').trim()} `;
    const out = { kind: null, title: '', date: null, allDay: false, start: null, end: null, categoryId: null, priority: 1, empty: false };
    const take = (re) => { const m = rest.match(re); if (m) rest = rest.replace(m[0], ' '); return m; };
    let force = null;
    const invalid = () => { out.invalid = true; out.error = '입력한 날짜나 시간을 확인해 주세요. 존재하는 날짜와 0~59분을 사용해 주세요.'; };
    const validDate = (y, mo, d) => {
      const candidate = new Date(y, mo - 1, d);
      return candidate.getFullYear() === y && candidate.getMonth() === mo - 1 && candidate.getDate() === d;
    };

    // 말머리: "할 일:" / "일정:"
    let m = take(/^\s*(할\s*일|일정)\s*[:：]\s*/);
    if (m) force = m[1].startsWith('할') ? 'todo' : 'event';

    // #카테고리
    m = rest.match(/(^|\s)#(\S+)/);
    if (m) {
      const name = m[2];
      const cat = cats.find((c) => c.name === name) || cats.find((c) => c.name.startsWith(name));
      if (cat) { out.categoryId = cat.id; rest = rest.replace(m[0], ' '); }
    }
    // 중요 표시
    if (take(/(^|\s)!{1,}(?=\s|$)/)) out.priority = 2;
    // 종일
    if (take(/(^|\s)종일(?=\s|$|에)/)) out.allDay = true;

    // ---- 시각 (오후 3시 30분 / 3시 반 / 15:30 / 3시~4시 / 2시부터 4시까지)
    const times = [];
    const timeRe = new RegExp(`${MER}?\\s*(\\d{1,2})\\s*(?:시(?!간)(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?|:(\\d{2}))`, 'g');
    rest = rest.replace(timeRe, (all, mer, h, mm, half, colon) => {
      const hour = Number(h), minute = colon ? Number(colon) : mm ? Number(mm) : half ? 30 : 0;
      if (hour > 24 || minute > 59 || (hour === 24 && (minute !== 0 || mer)) || (mer && hour > 12)) { invalid(); return all; }
      times.push({ mer, h: hour, min: minute, colon: !!colon });
      return ' ';
    });
    let startMin = null;
    let endMin = null;
    if (times.length) {
      const t0 = times[0];
      startMin = t0.colon && !t0.mer && t0.h >= 0 ? t0.h * 60 + t0.min : toMinutes(t0.h, t0.mer, t0.min);
      if (times[1]) {
        const t1 = times[1];
        endMin = t1.colon && !t1.mer ? t1.h * 60 + t1.min : toMinutes(t1.h, t1.mer, t1.min, startMin);
        if (endMin <= startMin) endMin = null;
      }
    }

    // ---- 길이 (1시간 / 1시간 반 / 1.5시간 / 30분)
    let dur = null;
    m = take(/(\d+(?:\.\d+)?)\s*시간(\s*반)?/);
    if (m) dur = Math.round(parseFloat(m[1]) * 60 + (m[2] ? 30 : 0));
    else if ((m = take(/(\d+)\s*분(?=\s|$)/))) dur = Number(m[1]);

    // ---- 날짜
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let date = null;
    const setYMD = (y, mo, d) => { if (!validDate(y, mo, d)) invalid(); else date = new Date(y, mo - 1, d); };
    const nextMD = (mo, d) => { // 연도가 없으면 오늘 이후로 가장 가까운 날
      if (mo < 1 || mo > 12 || d < 1 || d > 31) { invalid(); return; }
      for (let year = today.getFullYear(); year <= today.getFullYear() + 8; year++) {
        if (!validDate(year, mo, d)) continue;
        const candidate = new Date(year, mo - 1, d);
        if (candidate >= today) { date = candidate; return; }
      }
      invalid();
    };
    if ((m = take(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) setYMD(+m[1], +m[2], +m[3]);
    else if ((m = take(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) nextMD(+m[1], +m[2]);
    else if ((m = take(/(^|\s)(오늘|내일|모레|글피|어제|그저께)(?=\s|$|에)/))) date = addDays(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3, 어제: -1, 그저께: -2 }[m[2]]);
    else if ((m = take(/(\d+)\s*일\s*(뒤|후)/))) date = addDays(today, +m[1]);
    else if ((m = take(/(\d+)\s*주\s*(뒤|후)/))) date = addDays(today, +m[1] * 7);
    else if ((m = take(/(이번|다음|다다음)\s*주\s*([일월화수목금토])\s*요일?/))) {
      const base = addDays(today, -today.getDay() + { 이번: 0, 다음: 7, 다다음: 14 }[m[1]]);
      date = addDays(base, DOW.indexOf(m[2]));
    } else if ((m = take(/(이번|다음)\s*달\s*(\d{1,2})\s*일/))) {
      const mo = today.getMonth() + (m[1] === '다음' ? 1 : 0);
      const targetMonth = new Date(today.getFullYear(), mo, 1);
      setYMD(targetMonth.getFullYear(), targetMonth.getMonth() + 1, +m[2]);
    } else if ((m = take(/(^|\s)(다음\s*주)(?=\s|$)/))) date = addDays(today, 7);
    else if ((m = take(/([일월화수목금토])\s*요일/))) {
      const diff = (DOW.indexOf(m[1]) - today.getDay() + 7) % 7;
      date = addDays(today, diff);
    } else if ((m = take(/(^|\s)(\d{1,2})[/.](\d{1,2})(?!\s*[시분\d:])(?=\s|$)/))) nextMD(+m[2], +m[3]);
    else if ((m = take(/(^|\s)(\d{1,2})\s*일(?=\s|$|에)/))) {
      const day = +m[2];
      if (day < 1 || day > 31) invalid();
      else for (let offset = 0; offset <= 12; offset++) {
        const month = new Date(today.getFullYear(), today.getMonth() + offset, 1);
        if (!validDate(month.getFullYear(), month.getMonth() + 1, day)) continue;
        const candidate = new Date(month.getFullYear(), month.getMonth(), day);
        if (candidate >= today) { date = candidate; break; }
      }
    }

    // ---- 제목 정리: 남은 조사·연결 기호 제거
    let title = rest
      .replace(/(^|\s)(부터|까지|~|-|–|에는|에)(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    title = title.replace(/^(에|에는)\s+/, '');
    out.title = title;
    out.empty = !title;

    if ((date && !Number.isFinite(date.getTime())) || (dur != null && !Number.isFinite(dur))) invalid();
    if (out.invalid) { out.title = String(input || '').trim(); return out; }
    const hasTime = startMin != null;
    out.kind = force || (out.allDay || hasTime ? 'event' : 'todo');
    if (out.kind === 'event') {
      const d = date || today;
      out.date = key(d);
      if (out.allDay || !hasTime) {
        out.allDay = true;
        out.start = out.end = out.date;
      } else {
        const len = endMin != null ? endMin - startMin : dur != null ? dur : 60;
        const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin);
        const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin + Math.max(5, len));
        if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e.getFullYear() > 9999) { invalid(); return out; }
        const f = (x) => `${key(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
        out.start = f(s);
        out.end = f(e);
      }
    } else {
      out.date = date ? key(date) : null;
    }
    return out;
  }

  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuickAdd = api;
})(typeof window !== 'undefined' ? window : globalThis);
