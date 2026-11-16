// Pure offline journal. Persist each returned state before sending its request.
// No network, filesystem, account tokens, or device settings are stored here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlannerSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KINDS = Object.freeze(['events', 'todos', 'projects', 'categories', 'goalRecords', 'goalDays']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_REVISION = Number.MAX_SAFE_INTEGER;
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const keyOf = (kind, id) => JSON.stringify([kind, id]);
  const revision = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
  const equal = (a, b) => stable(a) === stable(b);
  function stable(value) {
    if (value === undefined) return 'undefined';
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  function uuid() {
    let cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!cryptoApi && typeof require === 'function') cryptoApi = require('node:crypto').webcrypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    if (!cryptoApi?.getRandomValues) throw new Error('Secure random identifiers are unavailable');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function utf8Length(text) {
    let count = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      count += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4;
    }
    return count;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value.slice(0, 4) !== '0000';
  }
  function validDateTime(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/.test(value) && validDate(value.slice(0, 10));
  }
  function itemId(kind, data) {
    if (!object(data)) throw new Error('A sync item must be an object');
    const id = kind === 'goalDays' ? data.goalId + '|' + data.date : data.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 512) throw new Error('Invalid sync item identifier');
    if (kind === 'goalDays' && (typeof data.goalId !== 'string' || !data.goalId.trim() || !validDate(data.date) || data.status !== 'missed'))
      throw new Error('Invalid missed-day record');
    if (kind === 'goalRecords' && (typeof data.activityId !== 'string' || !data.activityId.trim() || !validDate(data.date)))
      throw new Error('Invalid practice record');
    return id;
  }
  function checkItem(kind, id, data) {
    if (!KINDS.includes(kind) || typeof id !== 'string' || !id.trim() || id.length > 512) throw new Error('Invalid sync item key');
    if (data !== null && itemId(kind, data) !== id) throw new Error('Sync item identifier does not match its data');
    if (data !== null && utf8Length(JSON.stringify(data)) > 200000) throw new Error('Sync item exceeds 200000 bytes');
    if (data === null) return;
    for (const field of ['title', 'memo']) {
      if (own(data, field) && typeof data[field] !== 'string') throw new Error('Invalid sync text field: ' + field);
    }
    for (const field of ['due', 'repeatUntil']) {
      if (data[field] != null && data[field] !== '' && !validDate(data[field])) throw new Error('Invalid sync date field: ' + field);
    }
    if (kind === 'events') {
      if (!validDateTime(data.start) || (own(data, 'end') && (!validDateTime(data.end) || data.end.length !== data.start.length)))
        throw new Error('Invalid event start or end');
      if (own(data, 'end') && (data.end < data.start || (data.timeType === 'point' && data.end !== data.start)))
        throw new Error('Inconsistent event time range');
      if (own(data, 'repeat') && !['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(data.repeat)) throw new Error('Invalid event repeat');
      if (own(data, 'exceptions') && (!Array.isArray(data.exceptions) || data.exceptions.some(date => !validDate(date)))) throw new Error('Invalid event exceptions');
      if (own(data, 'allDay') && typeof data.allDay !== 'boolean') throw new Error('Invalid event all-day flag');
    }
    if (kind === 'todos' && own(data, 'done') && typeof data.done !== 'boolean') throw new Error('Invalid task completion flag');
    if (kind === 'categories' && (typeof data.name !== 'string' || (own(data, 'color') && !/^#[0-9a-f]{3,8}$/i.test(data.color))))
      throw new Error('Invalid category fields');
  }
  function extract(data) {
    if (!object(data)) throw new Error('Planner data must be an object');
    const rows = {};
    for (const kind of KINDS) {
      const items = data[kind] === undefined ? [] : data[kind];
      if (!Array.isArray(items)) throw new Error('Planner collection is not an array: ' + kind);
      for (const raw of items) {
        const item = clone(raw), id = itemId(kind, item), key = keyOf(kind, id);
        checkItem(kind, id, item);
        if (own(rows, key)) throw new Error('Duplicate sync item identifier: ' + kind);
        rows[key] = { kind, id, data: item };
      }
    }
    return rows;
  }
  function checkOperation(op) {
    if (!object(op) || !UUID.test(op.opId) || !revision(op.baseRevision)) throw new Error('Invalid sync operation');
    checkItem(op.kind, op.id, op.data);
  }
  function validateState(input, expected = {}) {
    if (!object(input) || input.schemaVersion !== 1 || !UUID.test(input.accountId) || !UUID.test(input.deviceId) ||
        !revision(input.cursor) || !object(input.base) || !object(input.local) || !object(input.pending) ||
        !Array.isArray(input.conflictIds) || input.conflictIds.some(id => !UUID.test(id))) throw new Error('Invalid saved sync journal');
    if ((expected.accountId && input.accountId !== expected.accountId) || (expected.deviceId && input.deviceId !== expected.deviceId))
      throw new Error('Sync journal belongs to another account or device');
    const state = clone(input);
    for (const [key, row] of Object.entries(state.base)) {
      if (!object(row) || key !== keyOf(row.kind, row.id) || !revision(row.revision) || !row.revision) throw new Error('Invalid server baseline');
      checkItem(row.kind, row.id, row.data);
    }
    for (const [key, row] of Object.entries(state.local)) {
      if (!object(row) || key !== keyOf(row.kind, row.id) || row.data === null) throw new Error('Invalid local sync item');
      checkItem(row.kind, row.id, row.data);
    }
    for (const [key, op] of Object.entries(state.pending)) {
      checkOperation(op);
      if (key !== keyOf(op.kind, op.id)) throw new Error('Invalid pending sync item');
    }
    if (state.inFlight !== null) {
      const request = state.inFlight;
      if (!object(request) || request.deviceId !== state.deviceId || !revision(request.cursor) || request.cursor > state.cursor ||
          !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500 || !Array.isArray(request.ops) || request.ops.length > 100)
        throw new Error('Invalid saved in-flight request');
      const seen = new Set();
      for (const op of request.ops) {
        checkOperation(op);
        if (seen.has(op.opId)) throw new Error('Duplicate in-flight operation');
        seen.add(op.opId);
      }
    }
    return state;
  }
  function createState({ accountId, deviceId, data }) {
    if (!UUID.test(accountId) || !UUID.test(deviceId)) throw new Error('Account and device UUIDs are required');
    const state = { schemaVersion: 1, accountId, deviceId, cursor: 0, base: {}, local: {}, pending: {}, inFlight: null, conflictIds: [] };
    return stage(state, data || {});
  }
  function stage(input, data) {
    const state = validateState(input), next = extract(data);
    const flightKeys = new Set((state.inFlight?.ops || []).map(op => keyOf(op.kind, op.id)));
    for (const key of new Set([...Object.keys(state.local), ...Object.keys(next)])) {
      const before = own(state.local, key) ? state.local[key].data : null;
      const after = own(next, key) ? next[key].data : null;
      if (equal(before, after)) continue;
      const row = next[key] || state.local[key], base = state.base[key];
      if (!flightKeys.has(key) && equal(after, base?.data ?? null)) delete state.pending[key];
      else state.pending[key] = { opId: uuid(), kind: row.kind, id: row.id, baseRevision: base?.revision || 0, data: after };
    }
    state.local = next;
    return state;
  }
  function prepare(input, { limit = 100 } = {}) {
    const state = validateState(input);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid sync page limit');
    if (!state.inFlight) {
      const keys = [];
      let bytes = 512; // RPC field names, UUID, cursor and array punctuation.
      for (const key of Object.keys(state.pending)) {
        const nextBytes = utf8Length(JSON.stringify(state.pending[key])) + 1;
        if (keys.length >= 100 || bytes + nextBytes > 3 * 1024 * 1024) break;
        keys.push(key); bytes += nextBytes;
      }
      const ops = keys.map(key => state.pending[key]);
      for (const key of keys) delete state.pending[key];
      state.inFlight = { deviceId: state.deviceId, cursor: state.cursor, ops, limit };
    }
    return { state, request: clone(state.inFlight) };
  }
  function accept(input, response) {
    const state = validateState(input), request = state.inFlight;
    if (!request) throw new Error('No prepared sync request');
    if (!object(response) || !Array.isArray(response.acks) || !Array.isArray(response.changes) ||
        !revision(response.cursor) || response.cursor < state.cursor || typeof response.hasMore !== 'boolean' ||
        response.changes.length > request.limit || response.acks.length !== request.ops.length) throw new Error('Invalid sync response');
    const byId = new Map(request.ops.map(op => [op.opId, op]));
    const acknowledged = new Set();
    for (const ack of response.acks) {
      const op = byId.get(ack?.opId);
      if (!op || acknowledged.has(ack.opId) || ack.kind !== op.kind || ack.id !== op.id || !revision(ack.revision) || !ack.revision ||
          (ack.conflictId != null && !UUID.test(ack.conflictId))) throw new Error('Invalid operation acknowledgement');
      acknowledged.add(ack.opId);
      const key = keyOf(op.kind, op.id);
      if (!state.base[key] || state.base[key].revision < ack.revision)
        state.base[key] = { kind: op.kind, id: op.id, revision: ack.revision, data: op.data };
      // A newer local edit was made on top of this operation. It may use our own
      // acknowledgement as a baseline, but never a concurrently received edit.
      if (state.pending[key]) state.pending[key].baseRevision = ack.revision;
      if (ack.conflictId && !state.conflictIds.includes(ack.conflictId)) state.conflictIds.push(ack.conflictId);
    }
    let previous = request.cursor;
    for (const row of response.changes) {
      if (!object(row) || !revision(row.revision) || row.revision <= previous || row.revision > response.cursor) throw new Error('Invalid ordered server change');
      checkItem(row.kind, row.id, row.data);
      previous = row.revision;
      const key = keyOf(row.kind, row.id);
      if (!state.base[key] || state.base[key].revision < row.revision) state.base[key] = clone(row);
    }
    if (response.cursor !== previous || (response.hasMore && !response.changes.length)) throw new Error('Sync cursor does not match its change page');
    for (const [key, base] of Object.entries(state.base)) {
      if (state.pending[key]) {
        if (equal(state.pending[key].data, base.data)) delete state.pending[key];
        else continue;
      }
      if (base.data === null) delete state.local[key];
      else state.local[key] = { kind: base.kind, id: base.id, data: clone(base.data) };
    }
    state.cursor = response.cursor;
    state.inFlight = null;
    return state;
  }
  function materialize(input, localData = {}) {
    const state = validateState(input), out = clone(localData);
    for (const kind of KINDS) out[kind] = [];
    for (const row of Object.values(state.local)) out[row.kind].push(clone(row.data));
    return out;
  }
  function pendingCount(input) {
    const state = validateState(input);
    return Object.keys(state.pending).length + (state.inFlight?.ops.length || 0);
  }
  function mergeVisible(baseData, remoteData, localData) {
    const base = extract(baseData), remote = extract(remoteData), local = extract(localData);
    const merged = { ...remote }, missing = Symbol('missing');
    function mergeValue(before, received, current) {
      if (equal(current, before)) return received;
      if (equal(received, before) || equal(received, current)) return current;
      if (object(before) && object(received) && object(current)) {
        const out = Object.create(null);
        for (const key of new Set([...Object.keys(before), ...Object.keys(received), ...Object.keys(current)])) {
          const value = mergeValue(own(before, key) ? before[key] : missing, own(received, key) ? received[key] : missing, own(current, key) ? current[key] : missing);
          if (value !== missing) out[key] = value;
        }
        return out;
      }
      return current;
    }
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      const before = base[key]?.data ?? null, current = local[key]?.data ?? null;
      if (equal(before, current)) continue;
      if (current === null) delete merged[key];
      else {
        const row = local[key];
        merged[key] = { kind: row.kind, id: row.id, data: mergeValue(before, remote[key]?.data ?? null, current) };
      }
    }
    const out = clone(localData);
    for (const kind of KINDS) out[kind] = [];
    for (const row of Object.values(merged)) out[row.kind].push(clone(row.data));
    return out;
  }
  return Object.freeze({ KINDS, createState, validateState, stage, prepare, accept, materialize, pendingCount, mergeVisible });
});
