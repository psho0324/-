// 반복 일정 전개 로직 — Electron main(Node)과 렌더러(브라우저) 양쪽에서 같이 씁니다.
//
// 일정(event) 데이터 형태
// {
//   id, title, memo, color,
//   allDay: boolean,
//   start: "2026-10-25T14:00"  (종일이면 "2026-10-25"),
//   end:   "2026-10-25T15:00"  (종일이면 "2026-10-25", 마지막 날 포함),
//   repeat: "none" | "daily" | "weekly" | "monthly" | "yearly",
//   repeatInterval: 1,                 // N일/주/개월/년마다
//   repeatUntil: "2026-12-31" | null,  // 이 날짜까지(포함)
//   exceptions: ["2026-11-01"],        // 건너뛸 회차(회차 시작 날짜)
//   reminder: null | 0 | 5 | 10 ...    // 시작 N분 전 알림
// }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recurrence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const pad = (n) => String(n).padStart(2, '0');

  function parseLocal(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(str);
    if (!m) throw new Error('잘못된 날짜 형식: ' + str);
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtDateTime = (d) => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // base 시작 시각 기준 k번째 회차의 시작 시각
  function nthStart(ev, base, k) {
    const step = (ev.repeatInterval > 0 ? ev.repeatInterval : 1) * k;
    const y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
    const h = base.getHours(), mi = base.getMinutes();
    switch (ev.repeat) {
      case 'daily':
        return new Date(y, mo, d + step, h, mi);
      case 'weekly':
        return new Date(y, mo, d + 7 * step, h, mi);
      case 'monthly': {
        const total = mo + step;
        const ty = y + Math.floor(total / 12);
        const tm = ((total % 12) + 12) % 12;
        const last = new Date(ty, tm + 1, 0).getDate();
        return new Date(ty, tm, Math.min(d, last), h, mi); // 31일 → 말일로 보정
      }
      case 'yearly': {
        const ty = y + step;
        const last = new Date(ty, mo + 1, 0).getDate();
        return new Date(ty, mo, Math.min(d, last), h, mi); // 2/29 → 2/28 보정
      }
      default:
        return new Date(base);
    }
  }

  // 한 회차가 가질 수 있는 최대 간격(ms) — 시작 인덱스를 안전하게 건너뛰기 위함
  const MAX_UNIT_MS = { daily: 864e5, weekly: 7 * 864e5, monthly: 31 * 864e5, yearly: 366 * 864e5 };

  // [from, to) 구간과 겹치는 회차 목록: [{ start: Date, end: Date, key }]
  function occurrencesInRange(ev, from, to) {
    let base, end0;
    if (ev.allDay) {
      base = parseLocal(ev.start.slice(0, 10));
      const e = parseLocal((ev.end || ev.start).slice(0, 10));
      end0 = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1); // 마지막 날 포함
    } else {
      base = parseLocal(ev.start);
      end0 = ev.end ? parseLocal(ev.end) : new Date(base.getTime() + 3600e3);
    }
    const dur = Math.max(0, end0 - base);
    const calendarDays = ev.allDay ? Math.max(1, Math.round((
      Date.UTC(end0.getFullYear(), end0.getMonth(), end0.getDate()) -
      Date.UTC(base.getFullYear(), base.getMonth(), base.getDate())
    ) / 864e5)) : null;
    const skip = new Set(ev.exceptions || []);
    const out = [];

    const push = (s) => {
      // 종일 일정은 23/25시간인 서머타임 전환일에도 달력 날짜를 유지합니다.
      const e = ev.allDay
        ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + calendarDays)
        : new Date(s.getTime() + dur);
      if (!(s < to && (e > from || s >= from))) return;
      if (skip.has(fmtDate(s))) return;
      out.push({ start: s, end: e, key: ev.id + '|' + fmtDate(s) });
    };

    if (!ev.repeat || ev.repeat === 'none') {
      push(base);
      return out;
    }

    let until = null;
    if (ev.repeatUntil) {
      const u = parseLocal(ev.repeatUntil);
      until = new Date(u.getFullYear(), u.getMonth(), u.getDate() + 1); // 해당 날짜 끝까지
    }

    const stepMs = MAX_UNIT_MS[ev.repeat] * (ev.repeatInterval > 0 ? ev.repeatInterval : 1);
    let k = Math.max(0, Math.floor((from - base - dur) / stepMs) - 1);

    for (let i = 0; i < 20000; i++, k++) {
      const s = nthStart(ev, base, k);
      if (s >= to) break;
      if (until && s >= until) break;
      push(s);
    }
    return out;
  }

  return { parseLocal, fmtDate, fmtDateTime, occurrencesInRange };
});
