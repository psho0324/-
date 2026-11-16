// Isolated PostgreSQL-compatible engine; no production Supabase requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('../../node_modules/@electric-sql/pglite');
const S = require('../../desktop/renderer/sync-core');
const account = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const device = crypto.randomUUID();
const operation = (kind, id, data, baseRevision = 0) => ({ opId: crypto.randomUUID(), kind, id, data, baseRevision });
let passed = 0;
(async () => {
  const db = new PGlite();
  async function test(name, run) { await run(); passed++; console.log('PASS', name); }
  async function as(user, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
    await db.exec('set role ' + role);
  }
  async function sync(ops = [], cursor = 0, limit = 100, useDevice = device) {
    return (await db.query('select public.planner_sync($1::uuid,$2::bigint,$3::jsonb,$4::integer) as value', [useDevice, cursor, JSON.stringify(ops), limit])).rows[0].value;
  }
  async function conflicts() {
    return (await db.query('select public.planner_sync_list_conflicts() as value')).rows[0].value;
  }
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated;
      insert into auth.users values('${account}'),('${other}');`);
    const migration = fs.readFileSync(path.join(__dirname, '../migrations/004_planner_sync.sql'), 'utf8');
    await db.exec(migration);
    await test('Anonymous users cannot call sync or read planner tables', async () => {
      await as(null, 'anon');
      await assert.rejects(sync(), /permission denied/);
      await assert.rejects(db.query('select * from public.planner_sync_items'), /permission denied/);
      await assert.rejects(db.query('select * from public.planner_sync_conflicts'), /permission denied/);
    });
    await test('An authenticated role without a verified account identity is rejected', async () => {
      await as(null); await assert.rejects(sync(), /planner_login_required/);
    });
    let first, firstResponse;
    await test('Private sync creates an item and emits a cursor and acknowledgement', async () => {
      await as(account); first = operation('todos', 'task-1', { id: 'task-1', title: 'Original' });
      firstResponse = await sync([first]);
      assert.equal(firstResponse.acks[0].revision, 1); assert.equal(firstResponse.cursor, 1);
      assert.equal(firstResponse.changes[0].data.title, 'Original');
      assert.equal(firstResponse.hasMore, false);
    });
    await test('A committed operation can be retried without duplicating its revision', async () => {
      const retry = await sync([first]);
      assert.deepEqual(retry, firstResponse);
      await assert.rejects(sync([{ ...first, data: { id: 'task-1', title: 'Reused ID attack' } }]), /planner_operation_reused/);
      await assert.rejects(sync([first], 0, 100, crypto.randomUUID()), /planner_operation_reused/);
    });
    await test('Direct table writes are forbidden and account B cannot read account A data', async () => {
      await assert.rejects(db.query("update public.planner_sync_items set data='{}'::jsonb"), /permission denied/);
      await as(other); assert.deepEqual((await sync()).changes, []);
      assert.deepEqual(await conflicts(), []);
      await as(account);
    });
    await test('A stale concurrent edit preserves both versions in a private conflict record', async () => {
      await sync([operation('todos', 'task-1', { id: 'task-1', title: 'Device A' }, 1)]);
      const response = await sync([operation('todos', 'task-1', { id: 'task-1', title: 'Device B' }, 1)], 1, 100, crypto.randomUUID());
      assert(response.acks[0].conflictId);
      const rows = await conflicts(); assert.equal(rows.length, 1);
      assert.equal(rows[0].current_data.title, 'Device A'); assert.equal(rows[0].incoming_data.title, 'Device B');
      assert.equal(rows[0].current_revision, 2); assert.equal(rows[0].base_revision, 1);
      await as(other);
      assert.deepEqual(await conflicts(), []);
      assert.deepEqual((await db.query('select * from public.planner_sync_conflicts')).rows, []);
      await as(account);
    });
    await test('Every device sees its own account conflict count while another account sees zero', async () => {
      const firstDevice = await sync([], 0, 100, device);
      const anotherDevice = await sync([], 0, 100, crypto.randomUUID());
      assert.equal(firstDevice.conflictCount, 1);
      assert.equal(anotherDevice.conflictCount, 1);
      assert(Number.isSafeInteger(anotherDevice.conflictCount));
      await as(other);
      assert.equal((await sync([], 0, 100, crypto.randomUUID())).conflictCount, 0);
      await as(account);
    });
    await test('Tombstones are retained and a stale edit after deletion preserves the deletion in a conflict', async () => {
      let response = await sync([operation('todos', 'task-1', null, 3)], 3);
      assert.equal(response.changes[0].data, null);
      response = await sync([operation('todos', 'task-1', { id: 'task-1', title: 'Offline after delete' }, 3)], 4);
      assert(response.acks[0].conflictId);
      const rows = await conflicts(); assert(rows.some(row => row.current_data === null && row.incoming_data?.title === 'Offline after delete'));
    });
    await test('Pages advance monotonically while operations beyond the first page are still acknowledged', async () => {
      const ops = Array.from({ length: 4 }, (_, i) => operation('todos', 'page-' + i, { id: 'page-' + i, title: 'Page' }));
      let response = await sync(ops, 5, 1);
      assert.equal(response.acks.length, 4); assert.equal(response.cursor, 6); assert.equal(response.hasMore, true);
      const seen = [response.changes[0].id];
      while (response.hasMore) { response = await sync([], response.cursor, 1); seen.push(...response.changes.map(row => row.id)); }
      assert.deepEqual(seen, ['page-0', 'page-1', 'page-2', 'page-3']);
    });
    await test('Practice and missed-day payloads retain parent IDs without destructive foreign-key cascades', async () => {
      const response = await sync([
        operation('goalRecords', 'r1', { id: 'r1', activityId: 'removed-goal', date: '2026-11-13' }),
        operation('goalDays', 'removed-goal|2026-11-13', { goalId: 'removed-goal', date: '2026-11-13', status: 'missed' })
      ], 9);
      assert.equal(response.changes.length, 2);
      assert.equal(response.changes[1].data.goalId, 'removed-goal');
    });
    await test('Malformed operations and dates roll back an entire batch without applying the valid prefix', async () => {
      const prefix = operation('todos', 'rollback', { id: 'rollback', title: 'Must not commit' });
      await assert.rejects(sync([prefix, operation('goalDays', 'g|2026-02-30', { goalId: 'g', date: '2026-02-30', status: 'missed' })]), /planner_invalid_record_date/);
      const after = await sync([], 11); assert.equal(after.cursor, 11); assert.deepEqual(after.changes, []);
      await assert.rejects(sync([operation('todos', 'wrong', { id: 'different' })]), /planner_item_id_mismatch/);
      await assert.rejects(sync([operation('settings', 'private', { id: 'private' })]), /planner_invalid_item_key/);
      await assert.rejects(sync([{ ...prefix, id: 123 }]), /planner_invalid_operation/);
      await assert.rejects(sync([prefix, prefix]), /planner_invalid_operation/);
    });
    await test('Oversized input, invalid page bounds and a cursor ahead of the server are rejected', async () => {
      await assert.rejects(sync([operation('todos', 'huge', { id: 'huge', title: 'x'.repeat(200001) })]), /planner_invalid_item_data/);
      await assert.rejects(sync([], 0, 0), /planner_invalid_request/);
      await assert.rejects(sync([], 0, 501), /planner_invalid_request/);
      await assert.rejects(sync([], 99999), /planner_cursor_ahead/);
    });
    await test('Malformed event times, category fields and scalar titles cannot enter private storage', async () => {
      await assert.rejects(sync([operation('events', 'bad', { id: 'bad', title: 'Broken', start: '2026-02-30T09:00' })]), /planner_invalid_event_time/);
      await assert.rejects(sync([operation('events', 'bad', { id: 'bad', title: 'Broken', start: '2026-11-13T09:00', end: '2026-11-13T25:00' })]), /planner_invalid_event_time/);
      await assert.rejects(sync([operation('events', 'bad', { id: 'bad', title: 'Backwards', start: '2026-11-13T10:00', end: '2026-11-13T09:00' })]), /planner_invalid_event_time/);
      await assert.rejects(sync([operation('events', 'bad', { id: 'bad', title: 'Not point', start: '2026-11-13T10:00', end: '2026-11-13T11:00', timeType: 'point' })]), /planner_invalid_event_time/);
      await assert.rejects(sync([operation('categories', 'bad', { id: 'bad', color: '#abcdef' })]), /planner_invalid_category_fields/);
      await assert.rejects(sync([operation('todos', 'bad', { id: 'bad', title: 42 })]), /planner_invalid_text_field/);
      assert.deepEqual((await sync([], 11)).changes, []);
    });
    await test('The JS journal and actual SQL RPC agree across lost ACK, later edits and paged pulls', async () => {
      let state = S.createState({ accountId: other, deviceId: crypto.randomUUID(), data: { todos: [{ id: 'e2e', title: 'One' }] } });
      await as(other);
      const prepared = S.prepare(state, { limit: 1 }); state = prepared.state;
      await sync(prepared.request.ops, prepared.request.cursor, prepared.request.limit, state.deviceId);
      state = S.stage(state, { todos: [{ id: 'e2e', title: 'Two' }] });
      state = S.validateState(JSON.parse(JSON.stringify(state)));
      const retry = S.prepare(state);
      state = S.accept(retry.state, await sync(retry.request.ops, retry.request.cursor, retry.request.limit, state.deviceId));
      assert.equal(S.materialize(state).todos[0].title, 'Two');
      const next = S.prepare(state);
      state = S.accept(next.state, await sync(next.request.ops, next.request.cursor, next.request.limit, state.deviceId));
      assert.equal(S.pendingCount(state), 0); assert.equal(state.cursor, 2); assert.deepEqual(await conflicts(), []);
    });
    await test('Reapplying the migration preserves existing private data and RLS', async () => {
      await db.exec('reset role'); await db.exec(migration); await as(other);
      assert.equal((await sync()).changes[0].data.title, 'Two');
      await assert.rejects(db.query('select * from public.planner_sync_receipts'), /permission denied/);
    });
    await test('Large valid datasets are paged by bytes as well as row count without losing cursor progress', async () => {
      const rows = Array.from({ length: 18 }, (_, i) => operation('todos', 'large-' + i, { id: 'large-' + i, title: 'Large task', memo: 'x'.repeat(190000) }));
      let response = await sync(rows, 2, 100), received = response.changes.length;
      assert.equal(response.acks.length, rows.length); assert(response.changes.length < rows.length); assert(response.hasMore);
      assert(Buffer.byteLength(JSON.stringify(response)) < 4 * 1024 * 1024);
      while (response.hasMore) {
        response = await sync([], response.cursor, 100); received += response.changes.length;
        assert(Buffer.byteLength(JSON.stringify(response)) < 4 * 1024 * 1024);
      }
      assert.equal(received, rows.length); assert.equal(response.cursor, 20);
    });
    console.log(passed + ' private planner SQL checks passed');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
