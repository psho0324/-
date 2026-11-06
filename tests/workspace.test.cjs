const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
(async () => {
  const db = new PGlite(),
    owner = '00000000-0000-0000-0000-000000000001',
    other = '00000000-0000-0000-0000-000000000002';
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated;insert into auth.users values('${owner}'),('${other}');`
  );
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8'));
  await db.exec(
    'create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select,insert on storage.objects to anon,authenticated;'
  );
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/002_workspace.sql'),
    'utf8'
  );
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(
    `insert into site_admins values('${owner}');set request.jwt.claim.sub='${owner}';set role authenticated;`
  );
  const rpc = async (name, args = []) => {
    const values = args.map((_, i) => '$' + (i + 1)).join(',');
    return (await db.query(`select public.${name}(${values}) as result`, args)).rows[0].result;
  };
  const token = () => crypto.randomUUID();
  let all = await rpc('workspace_admin_list');
  assert.equal(all.total, 5);
  const project = {
    name: 'Example',
    description: 'Intro',
    category: 'TOOLS',
    status: 'building',
    tags: [],
    note: 'Full detail',
    url: '',
    imageUrl: '',
    showInProjects: true,
    sortOrder: 0
  };
  const request = token();
  let saved = await rpc('workspace_save', ['project', 'all', 0, project, false, request]);
  assert.equal(saved.revision, 1);
  const replay = await rpc('workspace_save', ['project', 'all', 0, project, false, request]);
  assert.equal(replay.revision, 1);
  await assert.rejects(
    rpc('workspace_save', ['project', 'all', 0, { ...project, name: 'Changed' }, false, request]),
    /workspace_request_reused/
  );
  await assert.rejects(
    rpc('workspace_save', ['project', 'all', null, project, false, token()]),
    /invalid/
  );
  await assert.rejects(
    rpc('workspace_save', ['project', 'bad id', 0, project, false, token()]),
    /workspace_invalid_id/
  );
  let published = await rpc('workspace_save', ['project', 'all', 1, project, true, token()]);
  assert.equal(published.revision, 2);
  let draft = await rpc('workspace_save', [
    'project',
    'all',
    2,
    { ...project, name: 'Unreleased name' },
    false,
    token()
  ]);
  assert.equal(draft.revision, 3);
  await assert.rejects(
    rpc('workspace_save', ['project', 'all', 2, { ...project, name: 'Stale edit' }, true, token()]),
    /workspace_conflict/
  );
  await db.exec("reset role;set request.jwt.claim.sub='';set role anon");
  const detail = await rpc('workspace_public_detail', ['project', 'all']);
  assert.equal(detail.data.name, 'Example');
  assert.equal((await rpc('workspace_public_list', ['project', 0, 1])).items.length, 1);
  assert.equal((await rpc('workspace_public_list', ['project', 1, 1])).items.length, 1);
  await assert.rejects(rpc('workspace_admin_list'), /permission denied|workspace_admin_required/);
  await assert.rejects(db.query('select * from workspace_items'), /permission denied/);
  await assert.rejects(db.query('select * from public.projects'), /permission denied/);
  await assert.rejects(db.query('select * from public.journal_entries'), /permission denied/);
  await db.exec(`reset role;set request.jwt.claim.sub='${other}';set role authenticated;`);
  await assert.rejects(
    rpc('workspace_save', ['project', 'hacker', 0, project, true, token()]),
    /workspace_admin_required/
  );
  await assert.rejects(rpc('workspace_export'), /workspace_admin_required/);
  await db.exec(`reset role;set request.jwt.claim.sub='${owner}';set role authenticated;`);
  await db.exec("insert into storage.objects values('workspace-media','uploads/private.png')");
  await db.exec("reset role;set request.jwt.claim.sub='';set role anon");
  assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
  await assert.rejects(
    db.query("insert into storage.objects values('workspace-media','uploads/attack.png')"),
    /row-level security/
  );
  await db.exec(`reset role;set request.jwt.claim.sub='${owner}';set role authenticated;`);
  const entry = {
    projectId: 'all',
    date: '2026-11-06',
    title: 'Entry',
    summary: 'Brief',
    body: 'Full body',
    images: []
  };
  const entryKey = token();
  await rpc('workspace_save', ['entry', 'entry-' + token(), 0, entry, true, entryKey]);
  await rpc('workspace_save', [
    'idea',
    'image-idea',
    0,
    { title: 'Image', summary: 'Summary', stage: 'idea', images: ['storage:uploads/private.png'] },
    true,
    token()
  ]);
  await db.exec("reset role;set request.jwt.claim.sub='';set role anon");
  assert.equal((await db.query('select * from storage.objects')).rows.length, 1);
  await db.exec(`reset role;set request.jwt.claim.sub='${owner}';set role authenticated;`);
  const filtered = await rpc('workspace_public_list', ['entry', 0, 12, 'all']);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].data.body, undefined);
  const trashed = await rpc('workspace_action', ['project', 'all', 3, 'trash', token(), null]);
  assert(trashed.deleted_at);
  assert.equal((await rpc('workspace_public_list', ['entry', 0, 12, 'all'])).total, 0);
  const restored = await rpc('workspace_action', ['project', 'all', 4, 'restore', token(), null]);
  assert.equal(restored.published, null);
  assert.equal(restored.draft.name, 'Unreleased name');
  const history = await rpc('workspace_item_history', ['project', 'all']);
  assert(history.length >= 4);
  const fromHistory = await rpc('workspace_action', [
    'project',
    'all',
    5,
    'history',
    token(),
    history.at(-1).event_id
  ]);
  assert.equal(fromHistory.revision, 6);
  const backup = await rpc('workspace_export');
  assert.equal(backup.format, 'wanderer-workspace');
  const restoreKey = token();
  const imported = await rpc('workspace_import', [backup, restoreKey]);
  assert(imported.restored >= 5);
  assert.deepEqual(await rpc('workspace_import', [backup, restoreKey]), imported);
  const after = await rpc('workspace_admin_list');
  assert.equal(after.total, all.total + 3 + imported.restored);
  for (const item of after.items.filter(
    (i) => i.id.startsWith('project-') || i.id.startsWith('entry-')
  )) {
    if (item.id.startsWith('project-')) assert.equal(item.published, null);
  }
  await db.exec('reset role');
  await db.exec(
    `insert into workspace_items(kind,id,published) select 'idea','scale-'||lpad(n::text,4,'0'),jsonb_build_object('title','Scale','summary','Summary','stage','idea') from generate_series(1,1050) n`
  );
  await db.exec(`set request.jwt.claim.sub='${owner}';set role authenticated;`);
  const largePage = await rpc('workspace_public_list', ['idea', 1000, 50]);
  assert(largePage.total > 1000);
  assert.equal(largePage.items.length, 50);
  assert.equal((await rpc('workspace_admin_list', [1000, 100])).items.length > 0, true);
  await db.exec('reset role');
  await db.exec("delete from workspace_items where id like 'scale-%'");
  await db.exec(`set request.jwt.claim.sub='${owner}';set role authenticated;`);
  const before = (await rpc('workspace_admin_list')).total;
  const invalid = structuredClone(backup);
  invalid.items.push({ kind: 'project', id: 'invalid', draft: { name: '' } });
  await assert.rejects(rpc('workspace_import', [invalid, token()]));
  assert.equal((await rpc('workspace_admin_list')).total, before);
  await db.close();
  console.log(
    'PASS: v2 migration preservation and repeatability, request idempotency, revision conflicts, public/draft separation, parent visibility, pagination, reserved all ID, trash/restore/history, transactional backup import, anonymous and non-admin denial.'
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
