// Local-only reminder scheduler. The host owns the timer and OS Notification API.
// Catch up at most the last 15 minutes. A large due set becomes two individual
// notices and one summary, rather than a stream of stale popups after sleep.
// Only an actual OS `show` acknowledgement is remembered across restarts.
const fs = require('node:fs');
const path = require('node:path');
const { occurrencesInRange } = require('./renderer/recurrence.js');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);

function createReminderScheduler(options = {}) {
  const {
    getData, notify, now = () => Date.now(), stateFile,
    catchUpMs = 15 * MINUTE, maxPerTick = 3, pendingTimeoutMs = 2 * MINUTE,
    retentionMs = 32 * DAY, maxRemembered = 10000, onError = () => {},
  } = options;
  if (typeof getData !== 'function' || typeof notify !== 'function') throw new TypeError('getData and notify are required');
  if (!Number.isFinite(catchUpMs) || catchUpMs < MINUTE || catchUpMs > DAY || !Number.isInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > 20) {
    throw new TypeError('Invalid reminder catch-up limits');
  }
  const readState = options.readState || (() => stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null);
  const writeState = options.writeState || (value => {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(value), 'utf8');
    fs.renameSync(stateFile + '.tmp', stateFile);
  });
  const shown = new Map();
  const active = new Map();
  let serial = 0, disposed = false, previousTick = null, lastResult = null;
  const error = (phase, cause) => {
    try { onError({ phase, message: String(cause?.message || cause || 'Reminder operation failed') }); } catch { /* diagnostics must not break local use */ }
  };
  try {
    const saved = readState();
    if (saved?.version === 1 && Array.isArray(saved.shown)) {
      for (const row of saved.shown.slice(-maxRemembered)) {
        if (typeof row?.key === 'string' && row.key.length <= 2048 && Number.isFinite(row.shownAt)) shown.set(row.key, row.shownAt);
      }
    }
  } catch (cause) { if (cause?.code !== 'ENOENT') error('read-state', cause); }

  function persist() {
    try { writeState({ version: 1, shown: [...shown].map(([key, shownAt]) => ({ key, shownAt })) }); }
    catch (cause) { error('write-state', cause); }
  }
  function prune(clock) {
    let changed = false;
    for (const [key, at] of shown) if (at < clock - retentionMs) { shown.delete(key); changed = true; }
    while (shown.size > maxRemembered) { shown.delete(shown.keys().next().value); changed = true; }
    if (changed) persist();
  }
  function validEvent(event) {
    return event && typeof event === 'object' && typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 512 &&
      typeof event.start === 'string' && typeof event.reminder === 'number' && Number.isFinite(event.reminder) && event.reminder >= 0 &&
      Number.isFinite(event.reminder * MINUTE) && REPEATS.has(event.repeat || 'none');
  }
  function eventOccurrences(event, from, to) {
    try { return occurrencesInRange(event, from, to); }
    catch { return []; } // malformed imported records must not stop other reminders
  }
  function current(member, events) {
    const event = events.get(member.eventId);
    if (!validEvent(event) || event.reminder !== member.reminder) return false;
    return eventOccurrences(event, member.start, new Date(member.start.getTime() + 1))
      .some(occurrence => occurrence.start.getTime() === member.start.getTime());
  }
  function cancel(entry) {
    active.delete(entry.id);
    try { entry.cancel?.(); } catch (cause) { error('cancel', cause); }
  }
  const dateText = date => `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  function individual(event, occurrence, clock) {
    const start = new Date(occurrence.start);
    const alertAt = new Date(start.getTime() - event.reminder * MINUTE);
    const missed = clock - alertAt.getTime() > MINUTE;
    const when = start.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const description = event.allDay
      ? `${start.getFullYear()}.${start.getMonth() + 1}.${start.getDate()} 종일 일정`
      : `${when} 시작` + (event.reminder ? ` (${event.reminder}분 전)` : '');
    return {
      kind: 'reminder', key: `${event.id}|${start.toISOString()}|${event.reminder}`,
      eventId: event.id, title: typeof event.title === 'string' && event.title ? event.title : '일정',
      body: (missed ? `놓친 알림 (${dateText(alertAt)}) · ` : '') + description,
      start, alertAt, reminder: event.reminder, missed,
    };
  }
  function dispatch(notice, members, clock, result) {
    const entry = { id: ++serial, members, at: clock, status: 'pending', cancel: null };
    active.set(entry.id, entry);
    const hooks = {
      shown() {
        if (active.get(entry.id) !== entry || entry.status !== 'pending') return;
        entry.status = 'shown';
        for (const member of members) shown.set(member.key, clock);
        prune(clock);
        persist();
      },
      failed(cause) {
        if (active.get(entry.id) !== entry) return;
        // A `failed` event after a successful `show` must not remove dedupe.
        active.delete(entry.id);
        if (entry.status === 'pending') { result.errors++; error('display', cause); }
      },
      closed() { active.delete(entry.id); },
    };
    result.dispatched++;
    try {
      const handle = notify(notice, hooks);
      if (typeof handle === 'function') entry.cancel = handle;
      else if (handle && typeof handle.close === 'function') entry.cancel = () => handle.close();
      else if (handle === true) hooks.shown();
      else if (handle === false) hooks.failed('Notification was not displayed');
    } catch (cause) { hooks.failed(cause); }
  }

  function tick() {
    const clock = Number(now());
    if (!Number.isFinite(clock)) throw new TypeError('Invalid reminder clock');
    const result = { enabled: false, due: 0, dispatched: 0, summaryItems: 0, errors: 0, pending: 0, shown: shown.size,
      checkedAt: clock, catchUpFrom: clock - catchUpMs, clockMovedBackwards: previousTick !== null && clock < previousTick };
    previousTick = clock;
    lastResult = result;
    if (disposed) return { ...result, disposed: true };
    let data;
    try { data = getData(); } catch (cause) { error('read-data', cause); result.errors++; return { ...result }; }
    const events = new Map((Array.isArray(data?.events) ? data.events : []).filter(validEvent).map(event => [event.id, event]));
    result.enabled = !!data && data.settings?.notifications !== false;
    for (const entry of active.values()) {
      if (!result.enabled || entry.members.some(member => !current(member, events)) ||
          (entry.status === 'pending' && clock - entry.at >= pendingTimeoutMs)) cancel(entry);
    }
    prune(clock);
    if (result.enabled) {
      const pending = new Set([...active.values()].filter(entry => entry.status === 'pending').flatMap(entry => entry.members.map(member => member.key)));
      const due = new Map();
      for (const event of events.values()) {
        // Query around occurrence times shifted by the reminder offset. A fixed
        // next-24-hours horizon misses valid notices scheduled multiple days ahead.
        const shift = event.reminder * MINUTE;
        const from = new Date(clock - catchUpMs + shift), to = new Date(clock + shift + 1);
        if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) continue;
        for (const occurrence of eventOccurrences(event, from, to)) {
          if (!Number.isFinite(occurrence.start.getTime())) continue;
          const member = individual(event, occurrence, clock);
          if (member.alertAt.getTime() > clock || member.alertAt.getTime() < clock - catchUpMs || shown.has(member.key) || pending.has(member.key)) continue;
          due.set(member.key, member);
        }
      }
      const members = [...due.values()].sort((a, b) => b.alertAt - a.alertAt || a.key.localeCompare(b.key));
      result.due = members.length;
      if (members.length <= maxPerTick) {
        for (const member of members) dispatch(member, [member], clock, result);
      } else {
        const individualCount = maxPerTick - 1;
        for (const member of members.slice(0, individualCount)) dispatch(member, [member], clock, result);
        const rest = members.slice(individualCount);
        result.summaryItems = rest.length;
        const examples = rest.slice(0, 3).map(member => `${dateText(member.alertAt)} ${member.title}`).join(' · ');
        dispatch({ kind: 'summary', title: `내 플래너 알림 ${rest.length}개`,
          body: examples + (rest.length > 3 ? ` · 외 ${rest.length - 3}개` : ''),
          keys: rest.map(member => member.key), items: rest, missed: rest.some(member => member.missed) }, rest, clock, result);
      }
    }
    result.pending = [...active.values()].filter(entry => entry.status === 'pending').length;
    result.shown = shown.size;
    return { ...result };
  }
  return {
    tick,
    getState: () => ({ ...(lastResult || {}), pending: [...active.values()].filter(entry => entry.status === 'pending').length, shown: shown.size, disposed }),
    dispose() { disposed = true; for (const entry of active.values()) cancel(entry); },
  };
}

module.exports = { createReminderScheduler };
