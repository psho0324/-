// 빠른 입력: "내일 오후 3시 치과 1시간 #업무" 같은 한 줄을 일정/할 일로 바꿉니다.
// parse(text, now, categories) → { kind: 'event'|'todo', title, date, allDay, timeType, start, end, categoryId, priority, empty }
//   event: timeType=point(시각만, start=end) | range(기간) | allDay(종일, start=end=date)
//   todo : date(마감일, 없으면 null)
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const DOW = '일월화수목금토';
  const MER = '(오전|오후|아침|점심|저녁|밤|새벽)';

  // 시(1~12 또는 24시간)와 오전/오후 말머리로 하루 중 분(minute)을 정합니다.
  function toMinutes(h, mer, min) {
    let hh = h;
    if (mer === '오후' || mer === '저녁' || mer === '밤') { if (hh < 12) hh += 12; }
    else if (mer === '점심') { if (hh < 11) hh += 12; }
    else if (mer === '오전' || mer === '아침' || mer === '새벽') { if (hh === 12) hh = 0; }
    else if (hh >= 1 && hh <= 6) hh += 12; // 말머리가 없으면 1~6시는 오후로 봄
    return hh * 60 + min;
  }

  function parse(input, now = new Date(), cats = []) {
    let rest = ` ${String(input || '').trim()} `;
    const out = { kind: null, title: '', date: null, allDay: false, timeType: null, start: null, end: null, categoryId: null, priority: 1, empty: false };
    const take = (re) => { const m = rest.match(re); if (m) rest = rest.replace(m[0], ' '); return m; };
    let force = null;
    const invalid = (message) => {
      if (!out.invalid) out.error = message || '입력한 날짜나 시간을 확인해 주세요. 존재하는 날짜와 0~59분을 사용해 주세요.';
      out.invalid = true;
    };
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

    // ---- 시각: 두 시각은 명시적인 연결 기호가 있을 때만 범위입니다.
    // 콜론 표기는 24시간제, 말머리 없는 한국어 시각은 기존 오전/오후 추정을 유지합니다.
    const times = [];
    const timeSource = rest;
    const timeRe = new RegExp(`(?<![\\d.])${MER}?\\s*(\\d{1,2})\\s*(?:시(?!간)(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?|:(\\d{2})(?!\\d))`, 'g');
    rest = rest.replace(timeRe, (all, mer, h, mm, half, colon, offset) => {
      const hour = Number(h), minute = colon ? Number(colon) : mm ? Number(mm) : half ? 30 : 0;
      if (hour > 24 || minute > 59 || (hour === 24 && (minute !== 0 || mer)) || (mer && (hour < 1 || hour > 12))) {
        invalid();
        return all;
      }
      times.push({ mer, h: hour, min: minute, colon: colon != null, from: offset, to: offset + all.length });
      return ' ';
    });
    if (/\d{1,}:\d+|\d{3,}\s*시(?!간)|\d+\.\d+\s*시(?!간)/.test(rest)) invalid();
    if (times.length > 2) invalid('시작과 종료 시각을 하나씩 입력해 주세요. 여러 일정은 따로 추가해 주세요.');
    let startMin = null;
    let endMin = null;
    if (times.length) {
      const t0 = times[0];
      startMin = t0.colon && !t0.mer ? t0.h * 60 + t0.min : toMinutes(t0.h, t0.mer, t0.min);
      if (times[1]) {
        const t1 = times[1];
        const between = timeSource.slice(t0.to, t1.from).trim();
        if (!/^(?:부터\s*)?(?:~|～|-|–|—)?$/.test(between) || !between) {
          invalid('시간 범위는 “9시부터 10시까지” 또는 “09:00~10:00”처럼 입력해 주세요.');
        }
        if (!t1.mer && !t1.colon && t1.h >= 1 && t1.h <= 12) {
          // “오후 2시~4시”, “밤 11시~1시”의 끝 시각은 시작 이후의 같은 12시간 시계입니다.
          endMin = Math.floor(startMin / 720) * 720 + (t1.h % 12) * 60 + t1.min;
          if (endMin < startMin) endMin += 720;
        } else {
          endMin = t1.colon && !t1.mer ? t1.h * 60 + t1.min : toMinutes(t1.h, t1.mer, t1.min);
          if (endMin < startMin) endMin += 1440; // 23:00~01:00은 다음 날 01:00까지
        }
        if (endMin === startMin) invalid('종료 시각은 시작 시각과 달라야 해요. 시각만 기록하려면 종료 시각을 빼 주세요.');
      }
    }

    // ---- 길이: 시간+분을 합산하고 “짜리/동안”도 제목에 남기지 않습니다.
    let dur = null;
    const durations = [];
    const durationRe = /(?<![\d.])(-?(?:\d+(?:\.\d+)?|\.\d+))\s*시간(?:\s*(반)|\s*(\d+)\s*분)?(?:\s*(?:짜리|동안))?|(?<![\d.])(-?(?:\d+(?:\.\d+)?|\.\d+))\s*분(?:\s*(?:짜리|동안))?/g;
    rest = rest.replace(durationRe, (all, hours, half, minutes, onlyMinutes) => {
      const value = hours != null ? Number(hours) * 60 + (half ? 30 : Number(minutes || 0)) : Number(onlyMinutes);
      durations.push(Math.round(value));
      if (!Number.isFinite(value) || value <= 0 || (hours != null && Number(hours) < 0) || !Number.isSafeInteger(Math.round(value)) || Math.round(value) < 1 || Math.abs(value - Math.round(value)) > 1e-7) {
        invalid('소요시간을 확인해 주세요. 1분 단위의 유효한 시간을 입력해 주세요.');
      }
      return ' ';
    });
    if (durations.length > 1) invalid('소요시간은 하나로 입력해 주세요. 예: “1시간 30분”.');
    if (durations.length) dur = durations[0];
    if (startMin != null && endMin != null && dur != null && endMin - startMin !== dur) {
      invalid('입력한 시간 범위와 소요시간이 달라요. 둘 중 하나를 고쳐 주세요.');
    }
    if (out.allDay && (times.length || dur != null)) invalid('종일 일정에는 시각이나 소요시간을 함께 넣을 수 없어요.');
    if (force === 'todo' && (times.length || dur != null)) invalid('할 일에는 마감 날짜를 넣을 수 있어요. 시각이나 소요시간을 쓰려면 일정으로 추가해 주세요.');
    if (dur != null && startMin == null) invalid('소요시간을 쓰려면 시작 시각도 입력해 주세요. 예: “9시 수업 2시간”.');

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
        out.timeType = 'allDay';
        out.start = out.end = out.date;
      } else {
        const len = endMin != null ? endMin - startMin : dur != null ? dur : 0;
        out.timeType = len === 0 ? 'point' : 'range';
        const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin);
        const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin + len);
        if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e.getFullYear() > 9999) { invalid(); return out; }
        const f = (x) => `${key(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
        out.date = key(s); // 24:00은 다음 날 00:00이므로 날짜 미리보기도 함께 이동합니다.
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
