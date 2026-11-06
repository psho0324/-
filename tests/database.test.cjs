const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const db = new PGlite();
  const admin = '00000000-0000-0000-0000-000000000001';
  const other = '00000000-0000-0000-0000-000000000002';
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    insert into auth.users values ('${admin}','owner@example.test'),('${other}','visitor@example.test');
  `);
  const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
  await db.exec(schema);
  await db.exec(`insert into public.site_admins values ('${admin}');
    insert into public.projects(id,name,description,is_published) values ('draft-project','非公開','draft',false);
    insert into public.journal_entries(project_id,date,title,summary,body,is_published) values
    ('calendar','2026-11-06','非公開記録','summary','body',false),
    ('draft-project','2026-11-06','非公開プロジェクトの記録','summary','body',true);
  `);
  async function rows(sql) {
    return (await db.query(sql)).rows;
  }
  await db.exec('set role anon');
  assert.equal((await rows('select * from projects')).length, 2);
  assert.equal((await rows('select * from journal_entries')).length, 3);
  await assert.rejects(db.query('select * from site_admins'), /permission denied/);
  await assert.rejects(
    db.query("insert into projects(id,name,description) values('attack','attack','attack')"),
    /permission denied/
  );
  await assert.rejects(
    db.query("update projects set name='attack' where id='calendar'"),
    /permission denied/
  );
  await assert.rejects(db.query('delete from journal_entries where id=1'), /permission denied/);
  await db.exec(`reset role; set request.jwt.claim.sub='${other}'; set role authenticated;`);
  assert.equal((await rows('select * from site_admins')).length, 0);
  assert.equal((await rows('select * from projects')).length, 2);
  assert.equal((await rows('select * from journal_entries')).length, 3);
  await assert.rejects(
    db.query("insert into projects(id,name,description) values('attack','attack','attack')"),
    /row-level security/
  );
  await assert.rejects(db.query(`insert into site_admins values('${other}')`), /permission denied/);
  assert.equal(
    (await rows("update projects set name='attack' where id='calendar' returning *")).length,
    0
  );
  assert.equal((await rows('delete from journal_entries where id=1 returning *')).length, 0);
  await db.exec(`reset role; set request.jwt.claim.sub='${admin}'; set role authenticated;`);
  assert.equal((await rows('select * from site_admins')).length, 1);
  assert.equal((await rows('select * from projects')).length, 3);
  assert.equal((await rows('select * from journal_entries')).length, 5);
  await db.exec(
    "insert into projects(id,name,description,is_published) values('new-app','New app','description',false)"
  );
  await db.exec("update projects set name='Updated', is_published=true where id='new-app'");
  const [entry] = await rows(
    "insert into journal_entries(project_id,date,title,summary,body) values('new-app','2026-11-06','Title','Summary','Body') returning id"
  );
  assert(Number(entry.id) > 3);
  await assert.rejects(db.query("delete from projects where id='new-app'"), /foreign key/);
  await db.exec(
    `delete from journal_entries where id=${Number(entry.id)}; delete from projects where id='new-app';`
  );
  await db.exec("update projects set is_published=false where id='workspace'");
  await db.exec('reset role; set role anon');
  assert.equal((await rows('select * from journal_entries')).length, 0);
  await db.exec("reset role; update projects set name='Preserve my edit' where id='calendar'");
  await db.exec(schema);
  assert.equal(
    (await rows("select name from projects where id='calendar'"))[0].name,
    'Preserve my edit'
  );
  assert.equal((await rows('select * from journal_entries')).length, 5);
  await db.close();
  console.log(
    'PASS: SQL creates and seeds data, repeatable without overwrites, anon read-only, non-admin denied, admin CRUD, no privilege escalation, drafts and draft-parent records hidden, FK restricts deletion.'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
