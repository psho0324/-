const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('../renderer/sync-core');
const account = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const device = () => crypto.randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const data = (todos = [], extras = {}) => ({ events: [], todos, projects: [], categories: [], goalRecords: [], goalDays: [], settings: { theme: 'dark', autoStart: true, notifications: false, dataDir: 'device-only' }, ...extras });
const todo = (title, id = 'task-1') => ({ id, title, done: false });
let passed = 0;
function test(name, fn) { fn(); console.log('PASS', name); passed++; }
class Server {
  constructor() { this.accounts = new Map(); }
  profile(user) {
    if (!this.accounts.has(user)) this.accounts.set(user, { revision: 0, rows: new Map(), receipts: new Map(), conflicts: [] });
    return this.accounts.get(user);
  }
  sync(user, request) {
    const p = this.profile(user), acks = [];
    for (const op of request.ops) {
      const fingerprint = JSON.stringify({ deviceId: request.deviceId, ...op });
      if (p.receipts.has(op.opId)) {
        const previous = p.receipts.get(op.opId); assert.equal(previous.fingerprint, fingerprint); acks.push(previous.ack); continue;
      }
      const key = JSON.stringify([op.kind, op.id]), previous = p.rows.get(key);
      let conflictId = null;
      if ((previous?.revision || 0) !== op.baseRevision && JSON.stringify(previous?.data ?? null) !== JSON.stringify(op.data)) {
        conflictId = crypto.randomUUID(); p.conflicts.push({ conflictId, current: previous?.data ?? null, incoming: op.data });
      }
      p.rows.set(key, { kind: op.kind, id: op.id, revision: ++p.revision, data: copy(op.data) });
      const ack = { opId: op.opId, kind: op.kind, id: op.id, revision: p.revision, conflictId };
      p.receipts.set(op.opId, { fingerprint, ack }); acks.push(ack);
    }
    const remaining = [...p.rows.values()].filter(row => row.revision > request.cursor).sort((a, b) => a.revision - b.revision);
    const changes = remaining.slice(0, request.limit);
    return copy({ acks, changes, cursor: changes.at(-1)?.revision || request.cursor, hasMore: remaining.length > changes.length });
  }
}
const fresh = (value = data(), user = account) => S.createState({ accountId: user, deviceId: device(), data: value });
function exchange(server, state, limit = 100) {
  const prepared = S.prepare(state, { limit });
  return S.accept(prepared.state, server.sync(state.accountId, prepared.request));
}
const visible = state => S.materialize(state, data());

test('Offline journal stages existing data without syncing device settings or requiring a server', () => {
  const input = data([todo('Local only')]);
  const original = copy(input), state = fresh(input);
  assert.equal(S.pendingCount(state), 1);
  assert.deepEqual(input, original);
  assert(!JSON.stringify(state).includes('device-only'));
  assert(!JSON.stringify(state).includes('autoStart'));
  assert.deepEqual(S.materialize(state, input), input);
});
test('Offline edits coalesce, and reverting an unsent addition removes its operation', () => {
  let state = fresh();
  state = S.stage(state, data([todo('A')]));
  state = S.stage(state, data([todo('B')]));
  assert.equal(S.pendingCount(state), 1);
  assert.equal(visible(state).todos[0].title, 'B');
  state = S.stage(state, data()); assert.equal(S.pendingCount(state), 0);
});
test('A durable request retries the same operation after a lost acknowledgement and app restart', () => {
  const server = new Server();
  let state = fresh(data([todo('A')]));
  const prepared = S.prepare(state); state = prepared.state;
  server.sync(account, prepared.request); // Connection lost after the server commits.
  state = S.stage(state, data([todo('B')]));
  state = S.validateState(copy(state), { accountId: account, deviceId: state.deviceId });
  const retry = S.prepare(state);
  assert.deepEqual(retry.request, prepared.request);
  state = S.accept(retry.state, server.sync(account, retry.request));
  assert.equal(server.profile(account).revision, 1);
  assert.equal(visible(state).todos[0].title, 'B');
  assert.equal(S.pendingCount(state), 1);
  state = exchange(server, state);
  assert.equal(S.pendingCount(state), 0);
  assert.equal(server.profile(account).revision, 2);
  assert.equal(server.profile(account).conflicts.length, 0);
});
test('Two offline devices retain both conflicting edits and converge without whole-file overwrite', () => {
  const server = new Server();
  let a = exchange(server, fresh(data([todo('Original')]))), b = exchange(server, fresh());
  a = S.stage(a, data([todo('Changed by A'), todo('Independent A', 'task-a')]));
  b = S.stage(b, data([todo('Changed by B'), todo('Independent B', 'task-b')]));
  a = exchange(server, a); b = exchange(server, b); a = exchange(server, a);
  assert.deepEqual(visible(a).todos.sort((x, y) => x.id.localeCompare(y.id)), visible(b).todos.sort((x, y) => x.id.localeCompare(y.id)));
  assert.equal(visible(a).todos.length, 3);
  assert.equal(server.profile(account).conflicts.length, 1);
  assert.equal(server.profile(account).conflicts[0].current.title, 'Changed by A');
  assert.equal(server.profile(account).conflicts[0].incoming.title, 'Changed by B');
  assert.equal(b.conflictIds.length, 1);
});
test('Concurrent deletion and edit preserve the tombstone in the conflict record', () => {
  const server = new Server();
  let a = exchange(server, fresh(data([todo('Original')]))), b = exchange(server, fresh());
  a = S.stage(a, data()); b = S.stage(b, data([todo('Edited offline')]));
  a = exchange(server, a); b = exchange(server, b); a = exchange(server, a);
  assert.equal(visible(a).todos[0].title, 'Edited offline');
  assert.equal(server.profile(account).conflicts[0].current, null);
});
test('An unsent edit is not silently rebased over a newer remote value during a pull', () => {
  const server = new Server();
  let a = exchange(server, fresh(data([todo('Original')]))), b = exchange(server, fresh());
  let flight = S.prepare(b); b = S.stage(flight.state, data([todo('Local draft')]));
  a = exchange(server, S.stage(a, data([todo('Remote edit')])));
  b = S.accept(b, server.sync(account, flight.request));
  assert.equal(visible(b).todos[0].title, 'Local draft');
  b = exchange(server, b);
  assert.equal(server.profile(account).conflicts.length, 1);
});
test('Paged change cursors keep tombstones and never skip writes acknowledged beyond the first page', () => {
  const server = new Server();
  let a = fresh(data(Array.from({ length: 5 }, (_, i) => todo('Task ' + i, 'id-' + i))));
  a = exchange(server, a, 1);
  assert.equal(a.cursor, 1); assert.equal(S.pendingCount(a), 0);
  for (let i = 0; i < 4; i++) a = exchange(server, a, 1);
  assert.equal(a.cursor, 5); assert.equal(visible(a).todos.length, 5);
  a = exchange(server, S.stage(a, data()), 1);
  let b = fresh();
  for (let i = 0; i < 5; i++) b = exchange(server, b, 1);
  assert.equal(b.cursor, 10); assert.deepEqual(visible(b).todos, []);
});
test('Practice, missed days and orphaned child records survive without cascading data loss', () => {
  const fixture = data([], {
    projects: [],
    goalRecords: [{ id: 'practice-1', activityId: 'deleted-parent', date: '2026-11-13' }],
    goalDays: [{ goalId: 'deleted-parent', date: '2026-11-13', status: 'missed' }]
  });
  const server = new Server(); exchange(server, fresh(fixture));
  const restored = visible(exchange(server, fresh()));
  assert.deepEqual(restored.goalRecords, fixture.goalRecords); assert.deepEqual(restored.goalDays, fixture.goalDays);
});
test('Account switching cannot reuse another account journal or expose its rows', () => {
  const server = new Server(), a = exchange(server, fresh(data([todo('Private')])));
  assert.throws(() => S.validateState(a, { accountId: other }), /another account/);
  assert.throws(() => S.validateState(a, { deviceId: device() }), /another account or device/);
  const b = exchange(server, fresh(data(), other)); assert.deepEqual(visible(b).todos, []);
});
test('Malformed receipts, duplicate acknowledgements and stale cursors leave the input untouched', () => {
  const server = new Server(), prepared = S.prepare(fresh(data([todo('Private')]))), before = copy(prepared.state);
  const response = server.sync(account, prepared.request);
  assert.throws(() => S.accept(prepared.state, { ...response, acks: [] }));
  assert.throws(() => S.accept(prepared.state, { ...response, changes: [{ ...response.changes[0], revision: 0 }] }));
  assert.throws(() => S.accept(prepared.state, { ...response, cursor: response.cursor + 10 }), /cursor/);
  assert.throws(() => S.accept(prepared.state, { ...response, changes: [], cursor: 0, hasMore: true }), /cursor/);
  assert.throws(() => S.accept(prepared.state, { ...response, acks: [{ ...response.acks[0], id: 'wrong' }] }));
  assert.deepEqual(prepared.state, before);
});
test('Duplicate identifiers, invalid record dates and oversized rows fail before mutating a journal', () => {
  const state = fresh();
  assert.throws(() => S.stage(state, data([todo('A'), todo('B')])));
  assert.throws(() => S.stage(state, data([], { goalDays: [{ goalId: 'g', date: '2026-02-30', status: 'missed' }] })));
  assert.throws(() => S.stage(state, data([todo('한'.repeat(70000))])), /200000/);
  assert.equal(S.pendingCount(state), 0);
});
test('Three-way UI merge retains edits and deletions made while a native sync event was in flight', () => {
  const base = data([todo('Base'), todo('Delete locally', 'remove')]);
  const remote = data([todo('Remote'), todo('Remote changed removal', 'remove'), todo('Remote addition', 'new')], { settings: { theme: 'light' } });
  const local = data([{ ...todo('Base'), note: 'Typing now' }]);
  const before = copy({ base, remote, local }), merged = S.mergeVisible(base, remote, local);
  assert.equal(merged.todos.find(t => t.id === 'task-1').title, 'Remote');
  assert.equal(merged.todos.find(t => t.id === 'task-1').note, 'Typing now');
  assert(!merged.todos.some(t => t.id === 'remove')); assert(merged.todos.some(t => t.id === 'new'));
  assert.deepEqual(merged.settings, local.settings);
  assert.deepEqual({ base, remote, local }, before);
});
test('Three-way merge favors the current local field on an overlapping edit and keeps a remote deletion editable', () => {
  const base = data([todo('Base')]), local = data([todo('Local')]);
  assert.equal(S.mergeVisible(base, data([todo('Remote')]), local).todos[0].title, 'Local');
  assert.equal(S.mergeVisible(base, data(), local).todos[0].title, 'Local');
});
test('Malformed remote event, category and scalar title fields are rejected before materialization', () => {
  const prepared = S.prepare(fresh());
  const malformed = [
    { kind: 'events', id: 'bad', data: { id: 'bad', title: 'Broken', start: '2026-02-30T09:00' } },
    { kind: 'events', id: 'bad', data: { id: 'bad', title: 'Backwards', start: '2026-11-13T10:00', end: '2026-11-13T09:00' } },
    { kind: 'events', id: 'bad', data: { id: 'bad', title: 'Not a point', start: '2026-11-13T10:00', end: '2026-11-13T11:00', timeType: 'point' } },
    { kind: 'categories', id: 'bad', data: { id: 'bad', color: '#abcdef' } },
    { kind: 'todos', id: 'bad', data: { id: 'bad', title: 42 } }
  ];
  for (const row of malformed) assert.throws(() => S.accept(prepared.state, { acks: [], changes: [{ ...row, revision: 1 }], cursor: 1, hasMore: false }));
  assert.deepEqual(S.materialize(prepared.state).events, []);
});
test('Large offline imports are split into immutable requests below the transport byte limit', () => {
  const rows = Array.from({ length: 25 }, (_, i) => todo('한'.repeat(50000), 'large-' + i));
  const prepared = S.prepare(fresh(data(rows)));
  assert(prepared.request.ops.length > 0 && prepared.request.ops.length < rows.length);
  assert(Buffer.byteLength(JSON.stringify(prepared.request)) < 3 * 1024 * 1024);
  assert.equal(S.pendingCount(prepared.state), rows.length);
  assert.deepEqual(S.prepare(copy(prepared.state)).request, prepared.request);
});
console.log(passed + ' offline sync core checks passed');
