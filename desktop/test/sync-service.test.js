const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSyncService } = require('../sync-service');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const clone = x => JSON.parse(JSON.stringify(x));
const blank = () => ({ events: [], todos: [], projects: [], categories: [], goalRecords: [], goalDays: [], settings: { theme: 'light' } });
const todo = (id, title) => ({ id, title, done: false });
const fixtures = [];
let passed = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function server() {
  const users = new Map();
  const calls = [];
  function sync(id, request) {
    calls.push({ id, request: clone(request) });
    if (!users.has(id)) users.set(id, { revision: 0, rows: new Map(), receipts: new Map(), changes: [], conflicts: [] });
    const user = users.get(id), acks = [];
    for (const op of request.p_ops) {
      if (user.receipts.has(op.opId)) { acks.push(clone(user.receipts.get(op.opId))); continue; }
      const key = JSON.stringify([op.kind, op.id]);
      const previous = user.rows.get(key);
      const conflictId = (previous?.revision || 0) !== op.baseRevision ? randomUUID() : null;
      if (conflictId) user.conflicts.push({ id: conflictId, previous: clone(previous), incoming: clone(op) });
      const row = { kind: op.kind, id: op.id, data: clone(op.data), revision: ++user.revision };
      user.rows.set(key, row); user.changes.push(row);
      const ack = { opId: op.opId, kind: op.kind, id: op.id, revision: row.revision, conflictId };
      user.receipts.set(op.opId, ack); acks.push(ack);
    }
    const all = user.changes.filter(row => row.revision > request.p_cursor);
    const changes = all.slice(0, request.p_limit);
    return { acks, changes: clone(changes), cursor: changes.at(-1)?.revision || request.p_cursor, hasMore: all.length > changes.length };
  }
  return { sync, calls, users };
}
function fakeTimers() {
  const pending = new Map(); let seq = 0;
  return { pending, setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; }, clearTimeout(id) { pending.delete(id); },
    fire() { const entry = pending.entries().next().value; if (!entry) return; pending.delete(entry[0]); entry[1].fn(); } };
}
function fixture({ backend = server(), initial = blank(), userId = A, authenticated = true, configured = true, dir = null, beforeApply = null, afterNative = null } = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'planner-sync-service-'));
  let data = clone(initial), auth = { configured, backendId: configured ? 'https://planner-a.supabase.co' : null, authenticated, user: authenticated ? { id: userId, email: userId === A ? 'a@example.test' : 'b@example.test' } : null };
  const nativeFile = path.join(dir, 'planner-data.json');
  fs.writeFileSync(nativeFile, JSON.stringify(data));
  let failSave = false, overrideRpc = null, service;
  const listeners = new Set(), states = [], updates = [], timers = fakeTimers();
  const account = {
    getState: () => clone(auth),
    rpc: async (name, request, options) => { assert.equal(name, 'planner_sync'); assert(auth.authenticated); assert.equal(options.accountId, auth.user.id); return overrideRpc ? overrideRpc(request) : backend.sync(auth.user.id, request); },
    onState: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const deps = {
    userDataDir: dir, account, timers, now: () => Date.UTC(2026, 10, 13, 9),
    loadData: () => JSON.parse(fs.readFileSync(nativeFile, 'utf8')),
    saveData: value => { if (failSave) throw Error('Synthetic native write failure'); fs.writeFileSync(nativeFile, JSON.stringify(value)); data = clone(value); return true; },
    onData: (value, meta) => { updates.push({ value: clone(value), meta: clone(meta) }); if (afterNative) afterNative(value, meta, api); }, onState: value => states.push(value),
    beforeApply: async meta => beforeApply ? beforeApply(meta, api) : true,
  };
  const api = {
    backend, dir, timers, states, updates,
    get data() { return clone(data); },
    get service() { return service; },
    userSave(value) { fs.writeFileSync(nativeFile, JSON.stringify(value)); data = clone(value); return service.localSaved(data); },
    auth(value) { auth = { backendId: 'https://planner-a.supabase.co', ...clone(value) }; for (const fn of listeners) fn(auth); },
    setRpc(fn) { overrideRpc = fn; }, setFailSave(value) { failSave = value; },
    restart() { service.dispose(); service = createSyncService(deps); service.start(); return service; },
    close() { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  service = createSyncService(deps); service.start(); fixtures.push(api); return api;
}
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }
(async () => {
  await test('Guest and authenticated-but-unconnected users make zero requests and keep local data', async () => {
    for (const authenticated of [false, true]) {
      const f = fixture({ authenticated });
      f.userSave({ ...f.data, todos: [todo('guest', 'Offline task')] });
      await f.service.syncNow();
      assert.equal(f.backend.calls.length, 0); assert.equal(f.data.todos[0].title, 'Offline task');
      assert.equal(f.timers.pending.size, 0); assert.equal(fs.existsSync(path.join(f.dir, 'planner-sync-state.json')), false);
    }
  });
  await test('First import requires explicit connect and preserves native-only settings', async () => {
    const data = { ...blank(), todos: [todo('one', 'Existing local task')], settings: { theme: 'dark', autoStart: true, keepRunning: false } };
    const f = fixture({ initial: data });
    await f.service.connect({ importLocal: true });
    assert.equal(f.backend.calls.length, 0);
    await f.service.syncNow();
    assert.equal(f.service.getState().pending, 0); assert.equal(f.service.getState().status, 'synced');
    assert.deepEqual(f.data.settings, data.settings);
    const sent = JSON.stringify(f.backend.calls);
    assert(!sent.includes('autoStart')); assert(!sent.includes('theme')); assert(!sent.includes('keepRunning'));
  });
  await test('Connecting without import keeps guest data separate from the account', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('guest', 'Guest-only note')] } });
    await f.service.connect({ importLocal: false });
    assert.equal(f.data.todos.length, 0); await f.service.syncNow();
    assert.equal(f.backend.calls[0].request.p_ops.length, 0);
    await f.service.disconnect(); assert.equal(f.data.todos[0].title, 'Guest-only note');
  });
  await test('Two devices automatically pull and merge changes while retaining their own preferences', async () => {
    const backend = server();
    const a = fixture({ backend, initial: { ...blank(), todos: [todo('shared', 'First device')], settings: { theme: 'dark', autoStart: true } } });
    const b = fixture({ backend, initial: { ...blank(), settings: { theme: 'light', autoStart: false } } });
    await a.service.connect({ importLocal: true }); await a.service.syncNow();
    await b.service.connect(); await b.service.syncNow();
    assert.equal(b.data.todos[0].title, 'First device'); assert.equal(b.data.settings.theme, 'light');
    b.userSave({ ...b.data, todos: [...b.data.todos, todo('second', 'Offline second-device edit')] });
    await b.service.syncNow(); await a.service.syncNow();
    assert.equal(a.data.todos.length, 2); assert.equal(a.data.settings.theme, 'dark');
    assert(a.updates.some(u => u.meta.reason === 'sync' && u.meta.baseData.todos.length === 1));
    assert.equal(a.timers.pending.size, 1);
  });
  await test('Edits saved during an in-flight request survive its response and reach the server', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('one', 'Before request')] } });
    await f.service.connect({ importLocal: true });
    let release, seen;
    f.setRpc(async request => {
      if (!seen) { seen = clone(request); await new Promise(resolve => { release = resolve; }); }
      return f.backend.sync(A, request);
    });
    const run = f.service.syncNow(); await tick(); assert(release);
    f.userSave({ ...f.data, todos: [todo('one', 'Edited while sending')] });
    release(); await run;
    assert.equal(f.data.todos[0].title, 'Edited while sending');
    assert.equal(f.backend.users.get(A).rows.get('["todos","one"]').data.title, 'Edited while sending');
    assert.equal(f.service.getState().pending, 0);
  });
  await test('Renderer flush edits are captured before remote application', async () => {
    let applied = false;
    const f = fixture({ initial: { ...blank(), todos: [todo('one', 'Before flush')] }, beforeApply: async (meta, api) => {
      if (meta.reason === 'sync' && !applied) { applied = true; api.userSave({ ...api.data, todos: [todo('one', 'Saved by renderer flush')] }); }
      return true;
    } });
    await f.service.connect({ importLocal: true }); await f.service.syncNow();
    assert.equal(f.data.todos[0].title, 'Saved by renderer flush'); assert.equal(f.service.getState().pending, 0);
  });
  await test('A lost response survives restart and retries exactly the persisted operation IDs', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('one', 'Durable pending change')] } });
    await f.service.connect({ importLocal: true });
    f.setRpc(async request => { f.backend.sync(A, request); throw Error('Lost response after server commit'); });
    await f.service.syncNow();
    assert.equal(f.service.getState().status, 'retry');
    const first = f.backend.calls[0].request.p_ops;
    f.setRpc(null); f.restart(); await f.service.syncNow();
    assert.deepEqual(f.backend.calls[1].request.p_ops, first);
    assert.equal(f.backend.users.get(A).revision, 1); assert.equal(f.service.getState().pending, 0);
  });
  await test('Journal write failure preserves local save and prevents sending non-durable operations', async () => {
    const f = fixture(); await f.service.connect({ importLocal: true }); await f.service.syncNow();
    const calls = f.backend.calls.length, blocker = path.join(f.dir, 'planner-sync-state.json.tmp');
    fs.mkdirSync(blocker);
    assert.doesNotThrow(() => f.userSave({ ...f.data, todos: [todo('later', 'Saved despite journal failure')] }));
    assert.equal(f.data.todos[0].title, 'Saved despite journal failure'); assert.equal(f.service.getState().error.code, 'PLANNER_SYNC_STORAGE');
    await f.service.syncNow(); assert.equal(f.backend.calls.length, calls);
    fs.rmdirSync(blocker); await f.service.syncNow();
    assert.equal(f.service.getState().pending, 0); assert.equal(f.service.getState().error, null);
  });
  await test('Expired/offline authentication keeps the active profile and durable edits until reconnected', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('one', 'Account data')] } });
    await f.service.connect({ importLocal: true }); await f.service.syncNow();
    f.auth({ configured: true, authenticated: false, user: null, needsLogin: true });
    const count = f.backend.calls.length;
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('offline', 'Offline after token expiry')] }); f.restart();
    await f.service.syncNow(); assert.equal(f.backend.calls.length, count); assert.equal(f.service.getState().status, 'login-required');
    assert.equal(f.data.todos.length, 2);
    f.auth({ configured: true, authenticated: true, user: { id: A, email: 'a@example.test' } });
    await f.service.syncNow(); assert.equal(f.service.getState().pending, 0);
  });
  await test('Account switching cannot import another active profile and signout restores the original guest', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('guest', 'Original guest note')] } });
    await f.service.connect({ importLocal: true });
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('private-a', 'Only account A')] }); await f.service.syncNow();
    f.auth({ configured: true, authenticated: true, user: { id: B, email: 'b@example.test' } });
    assert.equal(f.service.getState().status, 'account-mismatch');
    await assert.rejects(f.service.connect({ importLocal: true }), e => e.code === 'PLANNER_ACCOUNT_SWITCH_REQUIRED');
    await f.service.disconnect(); assert.deepEqual(f.data.todos.map(t => t.id), ['guest']);
    await f.service.connect(); await f.service.syncNow(); assert.equal(f.data.todos.length, 0);
    assert.equal(f.backend.users.get(B).rows.size, 0);
    await f.service.disconnect(); f.auth({ configured: true, authenticated: true, user: { id: A, email: 'a@example.test' } });
    await f.service.connect(); assert(f.data.todos.some(t => t.id === 'private-a'));
  });
  await test('A cached session that requires reauthentication pauses networking while keeping local data usable', async () => {
    const f = fixture(); await f.service.connect({ importLocal: true }); await f.service.syncNow();
    f.auth({ configured: true, authenticated: true, needsLogin: true, user: { id: A, email: 'a@example.test' } });
    f.userSave({ ...f.data, todos: [todo('offline', 'Kept during reauthentication')] });
    const calls = f.backend.calls.length; await f.service.syncNow();
    assert.equal(f.backend.calls.length, calls); assert.equal(f.service.getState().status, 'login-required');
    assert.equal(f.service.getState().needsLogin, true); assert.equal(f.data.todos[0].id, 'offline');
    await assert.rejects(f.service.connect(), e => e.code === 'PLANNER_AUTH_REQUIRED');
  });
  await test('Changing Supabase projects never uploads cached profiles even when auth UUIDs are reused', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('private', 'Private first-project data')] } });
    await f.service.connect({ importLocal: true }); await f.service.syncNow();
    const calls = f.backend.calls.length;
    f.auth({ configured: true, backendId: 'https://planner-b.supabase.co', authenticated: true, user: { id: A, email: 'a@example.test' } });
    await f.service.syncNow(); assert.equal(f.backend.calls.length, calls);
    assert.equal(f.service.getState().status, 'backend-mismatch');
    await assert.rejects(f.service.connect(), e => e.code === 'PLANNER_SYNC_BACKEND_CHANGED');
    f.restart(); await f.service.syncNow(); assert.equal(f.backend.calls.length, calls);
    await f.service.disconnect();
    await assert.rejects(f.service.connect({ importLocal: true }), e => e.code === 'PLANNER_SYNC_BACKEND_CHANGED');
    f.auth({ configured: true, authenticated: true, user: { id: A, email: 'a@example.test' } });
    await f.service.connect(); assert.equal(f.data.todos[0].id, 'private');
  });
  await test('Interrupted profile transition preserves ambiguous later edits until explicit device-only recovery', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('guest', 'Guest snapshot')] } });
    await f.service.connect({ importLocal: true });
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('private', 'Account-only note')] });
    f.setFailSave(true); await assert.rejects(f.service.disconnect(), /Synthetic native write failure/);
    assert(JSON.parse(fs.readFileSync(path.join(f.dir, 'planner-sync-state.json'))).transition);
    f.setFailSave(false);
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('last', 'Saved after interrupted switch')] });
    f.restart(); assert(f.data.todos.some(t => t.id === 'last')); assert(f.data.todos.some(t => t.id === 'private'));
    assert.equal(f.service.getState().status, 'recovery-required'); assert.equal(f.service.getState().connected, false);
    await assert.rejects(f.service.connect(), e => e.code === 'PLANNER_SYNC_RECOVERY');
    await assert.rejects(f.service.resolveRecovery(), e => e.code === 'PLANNER_SYNC_RECOVERY_CHOICE');
    await f.service.resolveRecovery({ keepAsGuest: true });
    assert(f.data.todos.some(t => t.id === 'last'));
    const archive = fs.readdirSync(f.dir).find(name => name.startsWith('planner-sync-recovery-') && name.endsWith('.json'));
    assert(archive); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, archive))).targetData.todos.map(t => t.id), ['guest']);
    await f.service.connect(); assert(f.data.todos.some(t => t.id === 'last')); assert(f.data.todos.some(t => t.id === 'private'));
  });
  await test('A final sidecar failure after native switch cannot assign later target edits to the source account', async () => {
    let block = false;
    const f = fixture({ initial: { ...blank(), todos: [todo('guest', 'Guest snapshot')] }, afterNative: (_value, meta, api) => {
      if (block && meta.reason === 'profile') fs.mkdirSync(path.join(api.dir, 'planner-sync-state.json.tmp'));
    } });
    await f.service.connect({ importLocal: true });
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('private-a', 'Account A cached content')] });
    block = true;
    await assert.rejects(f.service.disconnect(), e => e.code === 'PLANNER_SYNC_STORAGE');
    assert.deepEqual(f.data.todos.map(t => t.id), ['guest']);
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('new-guest', 'Guest edit after native switch')] });
    fs.rmdirSync(path.join(f.dir, 'planner-sync-state.json.tmp')); block = false;
    f.restart(); assert.equal(f.service.getState().status, 'recovery-required');
    assert.deepEqual(f.data.todos.map(t => t.id), ['guest', 'new-guest']);
    await f.service.syncNow(); assert.equal(f.backend.calls.length, 0);
    await f.service.resolveRecovery({ keepAsGuest: true });
    await f.service.connect(); assert(f.data.todos.some(t => t.id === 'private-a'));
    assert(!f.data.todos.some(t => t.id === 'new-guest'));
    await f.service.disconnect(); assert(f.data.todos.some(t => t.id === 'new-guest'));
  });
  await test('Disposal while awaiting renderer flush cancels profile mutation', async () => {
    let release;
    const f = fixture({ beforeApply: async () => new Promise(resolve => { release = resolve; }) });
    const operation = f.service.connect({ importLocal: true }); await tick();
    f.service.dispose(); release(true);
    await assert.rejects(operation, e => e.code === 'PLANNER_SYNC_CLOSED');
    assert.equal(f.updates.length, 0); assert.equal(fs.existsSync(path.join(f.dir, 'planner-sync-state.json')), false);
  });
  await test('Unsynchronized edits are waiting even after an earlier successful sync', async () => {
    const f = fixture(); await f.service.connect({ importLocal: true }); await f.service.syncNow();
    assert.equal(f.service.getState().status, 'synced');
    f.userSave({ ...f.data, todos: [todo('pending', 'New local change')] });
    assert.equal(f.service.getState().status, 'waiting'); assert.equal(f.service.getState().pending, 1);
  });
  await test('Large remote histories continue promptly and do not claim completion while pages remain', async () => {
    const backend = server();
    backend.sync(A, { p_cursor: 0, p_limit: 100, p_ops: Array.from({ length: 2001 }, (_, i) => ({
      opId: randomUUID(), kind: 'todos', id: 'remote-' + i, baseRevision: 0, data: todo('remote-' + i, 'Remote item ' + i),
    })) });
    const f = fixture({ backend }); await f.service.connect(); await f.service.syncNow();
    assert.equal(f.data.todos.length, 2000); assert.equal(f.service.getState().pending, 0);
    assert.equal(f.service.getState().catchingUp, true); assert.equal(f.service.getState().status, 'waiting');
    assert.equal([...f.timers.pending.values()][0].ms, 1000);
    await f.service.syncNow(); assert.equal(f.data.todos.length, 2001);
    assert.equal(f.service.getState().status, 'synced'); assert.equal(f.service.getState().catchingUp, false);
  });
  await test('Conflicts created on another device remain visible after sync and restart without local conflict ACKs', async () => {
    const f = fixture(); await f.service.connect();
    f.setRpc(async request => ({ ...f.backend.sync(A, request), conflictCount: 7 }));
    await f.service.syncNow(); assert.equal(f.service.getState().conflictCount, 7);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'planner-sync-state.json')));
    assert.deepEqual(state.profiles[A].engine.conflictIds, []);
    f.restart(); assert.equal(f.service.getState().conflictCount, 7);
    f.setRpc(async request => ({ ...f.backend.sync(A, request), conflictCount: -1 }));
    await f.service.syncNow(); assert.equal(f.service.getState().status, 'retry');
    assert.equal(f.service.getState().conflictCount, 7);
    f.setRpc(null); await f.service.syncNow(); assert.equal(f.service.getState().conflictCount, 7);
  });
  await test('A response arriving after disconnect cannot overwrite guest data', async () => {
    const f = fixture({ initial: { ...blank(), todos: [todo('guest', 'Guest note')] } });
    await f.service.connect({ importLocal: true });
    let release;
    f.setRpc(async request => { await new Promise(resolve => { release = resolve; }); return f.backend.sync(A, request); });
    const pending = f.service.syncNow(); await tick();
    f.userSave({ ...f.data, todos: [...f.data.todos, todo('private', 'Private current account')] });
    await f.service.disconnect(); release(); await pending;
    assert.deepEqual(f.data.todos.map(t => t.id), ['guest']); assert.equal(f.service.getState().connected, false);
  });
  await test('A corrupt sidecar is preserved and synchronization never replaces it with a blank profile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-sync-corrupt-'));
    const file = path.join(dir, 'planner-sync-state.json'); fs.writeFileSync(file, '{ invalid retained file');
    const f = fixture({ dir });
    f.userSave({ ...f.data, todos: [todo('local', 'Guest continues')] }); await f.service.syncNow();
    await assert.rejects(f.service.connect({ importLocal: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), '{ invalid retained file'); assert.equal(f.backend.calls.length, 0);
    assert.equal(f.data.todos[0].title, 'Guest continues');
  });
  await test('Automatic retry uses a backoff timer and successful sync returns to ordinary polling', async () => {
    const f = fixture(); await f.service.connect({ importLocal: true });
    f.setRpc(async () => { throw Error('Offline'); }); await f.service.syncNow();
    assert.equal([...f.timers.pending.values()][0].ms, 5000);
    await f.service.syncNow(); assert.equal([...f.timers.pending.values()][0].ms, 10000);
    f.setRpc(null); f.timers.fire(); await f.service.syncNow();
    assert.equal(f.service.getState().status, 'synced'); assert.equal([...f.timers.pending.values()][0].ms, 60000);
  });
  await test('Failed renderer flush blocks native remote replacement until local saving recovers', async () => {
    let flush = true;
    const f = fixture({ initial: { ...blank(), todos: [todo('one', 'Local task')] }, beforeApply: async () => flush });
    await f.service.connect({ importLocal: true }); flush = false;
    await f.service.syncNow(); assert.equal(f.service.getState().error.code, 'PLANNER_SYNC_LOCAL_SAVE');
    assert.equal(f.data.todos[0].title, 'Local task');
    flush = true; await f.service.syncNow(); assert.equal(f.service.getState().pending, 0);
  });
  console.log(passed + ' native sync service checks passed');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => { for (const f of fixtures) f.close(); });
