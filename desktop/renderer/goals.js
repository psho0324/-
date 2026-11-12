// Repeating-goal calculations. Pure functions shared by the renderer and Node tests.
// A practice record belongs to an activity, not a goal. Explicitly linked goals can
// therefore evaluate the same record without duplicating the underlying activity.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlannerGoals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const isRepeating = (goal) => !!goal && (goal.mode === 'daily' || goal.mode === 'count');
  const fmt = (d) => `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function dateOf(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, day] = value.split('-').map(Number);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || day < 1 || day > 31) return null;
    // setFullYear avoids JavaScript's 1900 offset for years 1–99. Noon and setDate
    // avoid treating local calendar days as fixed 24-hour durations around DST.
    const d = new Date(0);
    d.setFullYear(y, m - 1, day);
    d.setHours(12, 0, 0, 0);
    return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day ? d : null;
  }
  const validDate = (value) => !!dateOf(value);
  const nextDay = (date, amount = 1) => {
    const out = new Date(date);
    out.setDate(out.getDate() + amount);
    return out;
  };
  const stringId = (value) => typeof value === 'string' && value.trim() ? value : null;
  const activityOf = (goal) => stringId(goal && goal.activityId) || stringId(goal && goal.id);

  function normalize(goal) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return {};
    const out = { ...goal };
    if (!isRepeating(goal)) return out; // v0.1.1 projects retain their original meaning.
    out.startDate = typeof goal.startDate === 'string' ? goal.startDate : '';
    out.due = goal.due == null || goal.due === '' ? null : goal.due;
    out.activityId = activityOf(goal);
    out.weekdays = Array.isArray(goal.weekdays)
      ? [...new Set(goal.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
      : [0, 1, 2, 3, 4, 5, 6];
    out.period = goal.period == null ? 'week' : goal.period;
    out.target = goal.target == null ? 1 : Number(goal.target);
    return out;
  }
  function validate(goal) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return '목표 정보를 확인해 주세요.';
    if (!isRepeating(goal)) return '';
    if (!validDate(goal.startDate)) return '시작 날짜를 확인해 주세요.';
    if (goal.due && !validDate(goal.due)) return '종료 날짜를 확인해 주세요.';
    if (goal.due && goal.due < goal.startDate) return '종료 날짜는 시작 날짜보다 빠를 수 없어요.';
    if (goal.mode === 'daily' && (!Array.isArray(goal.weekdays) || !goal.weekdays.length ||
      goal.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)))
      return '실천할 요일을 한 개 이상 선택해 주세요.';
    if (goal.mode === 'count' && (!['week', 'month'].includes(goal.period) ||
      !Number.isInteger(Number(goal.target)) || Number(goal.target) < 1 || Number(goal.target) > 1000000))
      return '목표 기간과 횟수(1~1,000,000회)를 확인해 주세요.';
    return '';
  }
  const policyFields = ['mode', 'startDate', 'due', 'weekdays', 'period', 'target', 'activityId'];
  function snapshot(goal, effectiveFrom) {
    const clean = normalize(goal);
    const out = { effectiveFrom };
    for (const key of policyFields) if (key in clean) out[key] = Array.isArray(clean[key]) ? [...clean[key]] : clean[key];
    if (!out.mode) out.mode = 'project';
    return out;
  }
  function historyOf(goal) {
    const entries = Array.isArray(goal.policyHistory)
      ? goal.policyHistory.filter((p) => p && typeof p === 'object' && validDate(p.effectiveFrom))
      : [];
    if (!entries.length) return [snapshot(goal, '0001-01-01')];
    // A repeated revision on the same effective date replaces only that revision.
    const byDate = new Map(entries.map((p) => [p.effectiveFrom, { ...p }]));
    return [...byDate.values()].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }
  function policyAt(goal, date) {
    if (!goal || !validDate(date)) return null;
    let selected = null;
    for (const entry of historyOf(goal)) {
      if (entry.effectiveFrom > date) break;
      selected = entry;
    }
    return selected ? normalize({ id: goal.id, ...selected }) : null;
  }
  function revise(goal, changes, effectiveFrom) {
    if (!validDate(effectiveFrom)) throw new Error('변경 적용 날짜를 확인해 주세요.');
    const updated = normalize({ ...goal, ...changes });
    const error = validate(updated);
    if (error) throw new Error(error);
    const history = historyOf(goal);
    const last = history[history.length - 1];
    if (effectiveFrom < last.effectiveFrom) throw new Error('이미 예약된 변경보다 과거에 조건을 덮어쓸 수 없어요.');
    const next = snapshot(updated, effectiveFrom);
    updated.policyHistory = [...history.filter((p) => p.effectiveFrom !== effectiveFrom), next];
    return updated;
  }
  function normalizeRecords(records) {
    const seen = new Set();
    return (Array.isArray(records) ? records : []).filter((record) => {
      if (!record || !stringId(record.id) || !stringId(record.activityId) || !validDate(record.date) || seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    }).map((record) => ({ ...record }));
  }
  function normalizeDays(days) {
    const byDay = new Map();
    for (const day of Array.isArray(days) ? days : []) {
      if (day && stringId(day.goalId) && validDate(day.date) && day.status === 'missed')
        byDay.set(JSON.stringify([day.goalId, day.date]), { ...day });
    }
    return [...byDay.values()];
  }
  function rangeFor(kind, today, weekStart) {
    if (kind === 'month') {
      const from = new Date(today);
      from.setDate(1);
      const to = new Date(from);
      to.setMonth(to.getMonth() + 1);
      to.setDate(0);
      return { from: fmt(from), to: fmt(to) };
    }
    const from = nextDay(today, -((today.getDay() - weekStart + 7) % 7));
    const to = nextDay(from, 6);
    return {
      from: from.getFullYear() < 1 ? '0001-01-01' : fmt(from),
      to: to.getFullYear() > 9999 ? '9999-12-31' : fmt(to)
    };
  }
  const activeOn = (policy, date) => isRepeating(policy) && !validate(policy) &&
    date >= policy.startDate && (!policy.due || date <= policy.due);

  function stats(goal, records = [], options = {}) {
    goal = goal && typeof goal === 'object' ? goal : {};
    const now = options.now === undefined ? new Date() : new Date(options.now);
    if (!Number.isFinite(now.getTime())) throw new Error('집계 날짜를 확인해 주세요.');
    const today = fmt(now);
    const reference = dateOf(today);
    const weekStart = Number(options.weekStart) === 1 ? 1 : 0;
    const range = options.range === 'month' ? 'month' : 'week';
    const visibleRange = rangeFor(range, reference, weekStart);
    const current = policyAt(goal, today) || normalize(goal);
    const missedDates = new Set(normalizeDays(options.goalDays).filter((d) => d.goalId === goal.id).map((d) => d.date));
    const counts = new Map();
    for (const record of normalizeRecords(records)) {
      const policy = policyAt(goal, record.date);
      if (record.date > today || !activeOn(policy, record.date) || record.activityId !== activityOf(policy)) continue;
      if (policy.mode === 'daily' && !policy.weekdays.includes(dateOf(record.date).getDay())) continue;
      counts.set(record.date, (counts.get(record.date) || 0) + 1);
    }
    const days = [];
    const lastDate = dateOf(visibleRange.to);
    for (let date = dateOf(visibleRange.from); date <= lastDate; date = nextDay(date)) {
      const key = fmt(date);
      const policy = policyAt(goal, key);
      const scheduled = !!activeOn(policy, key) && (policy.mode !== 'daily' || policy.weekdays.includes(date.getDay()));
      const count = counts.get(key) || 0;
      const status = !scheduled ? 'off' : key > today ? 'future' : count ? 'done'
        : missedDates.has(key) ? 'missed' : key === today ? 'pending' : 'unrecorded';
      days.push({ date: key, status, scheduled, records: count, mode: policy && policy.mode });
    }
    const out = {
      mode: current.mode || 'project', ...visibleRange, range,
      targetFrom: visibleRange.from, targetTo: visibleRange.to,
      targetLabel: range === 'month' ? '이번 달 실천율' : '이번 주 실천율',
      done: 0, total: 0, pct: null, rawPct: null,
      viewCount: days.reduce((sum, d) => sum + d.records, 0),
      completedCount: days.filter((d) => d.status === 'done').length,
      missed: days.filter((d) => d.status === 'missed').length,
      unrecorded: days.filter((d) => d.status === 'unrecorded').length,
      pending: days.filter((d) => d.status === 'pending').length,
      days, error: validate(current)
    };
    if (current.mode === 'daily') {
      // Pending today and future dates are not failures and do not dilute the rate.
      const eligible = days.filter((d) => d.mode === 'daily' && ['done', 'missed', 'unrecorded'].includes(d.status));
      out.done = eligible.filter((d) => d.status === 'done').length;
      out.total = eligible.length;
    } else if (current.mode === 'count' && !out.error) {
      const targetRange = rangeFor(current.period, reference, weekStart);
      out.targetFrom = targetRange.from;
      out.targetTo = targetRange.to;
      out.targetLabel = current.period === 'month' ? '이번 달 목표' : '이번 주 목표';
      out.done = [...counts.entries()].reduce((sum, [date, count]) =>
        date >= targetRange.from && date <= targetRange.to ? sum + count : sum, 0);
      // A quota is an intended count, not a future scheduled date. It is never
      // prorated by weekdays, month length, elapsed days, or the selected view.
      out.total = today >= current.startDate && targetRange.to >= current.startDate &&
        (!current.due || targetRange.from <= current.due) ? Number(current.target) : 0;
    }
    if (out.total > 0) {
      out.rawPct = Math.round(out.done / out.total * 100);
      out.pct = Math.min(100, out.rawPct);
    }
    return out;
  }
  function titleKey(title) {
    return String(title || '').normalize('NFKC').toLowerCase()
      .replace(/(?:이번|다음|지난)\s*(?:주|달|월)/g, ' ')
      .replace(/(?:매일|매주|매월|매달|일주일|하루|한\s*달|주간|월간|목표|습관)/g, ' ')
      .replace(/(?:주|월)\s*(?=\d)/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*(?:회|번|시간|분|일|주|개월|달)?/g, ' ')
      .replace(/하기(?=\s|$)/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }
  function titleSimilarity(a, b) {
    const left = titleKey(a), right = titleKey(b);
    if (left.length < 2 || right.length < 2) return 0;
    if (left === right) return 1;
    const pairs = (s) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
    const x = pairs(left), y = pairs(right);
    const same = [...x].filter((s) => y.has(s)).length;
    return 2 * same / (x.size + y.size);
  }
  function similarGoals(candidate, goals = []) {
    if (!candidate) return [];
    const start = validDate(candidate.startDate) ? candidate.startDate : '0001-01-01';
    const end = validDate(candidate.due) ? candidate.due : '9999-12-31';
    return (Array.isArray(goals) ? goals : []).filter((goal) => {
      if (!goal || goal.id === candidate.id || goal.status === 'done') return false;
      const otherStart = validDate(goal.startDate) ? goal.startDate : '0001-01-01';
      const otherEnd = validDate(goal.due) ? goal.due : '9999-12-31';
      return start <= otherEnd && otherStart <= end && titleSimilarity(candidate.title, goal.title) >= 0.88;
    });
  }
  return { isRepeating, validDate, normalize, validate, policyAt, revise, normalizeRecords, normalizeDays, stats, similarGoals, titleSimilarity };
});
