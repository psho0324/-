// Real PostgreSQL policies/RPCs behind a simulated Supabase HTTP/auth/storage boundary.
const { chromium } = require('playwright'),
  { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const root = path.join(__dirname, '..'),
  owner = '00000000-0000-0000-0000-000000000001',
  other = '00000000-0000-0000-0000-000000000002';
let db,
  browser,
  server,
  base,
  ownerPassword = 'test-password',
  loseSave = false,
  saveLost = false,
  failJournal = false;
const files = new Map(),
  errors = [];
let queue = Promise.resolve();
function sqlAs(token, sql, args = []) {
  const work = queue.then(async () => {
    try {
      await db.exec('begin');
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        token === 'test-owner' ? owner : token === 'test-other' ? other : ''
      ]);
      await db.exec('set local role ' + (token ? 'authenticated' : 'anon'));
      const result = await db.query(sql, args);
      await db.exec('commit');
      return result;
    } catch (e) {
      await db.exec('rollback');
      throw e;
    }
  });
  queue = work.catch(() => {});
  return work;
}
async function routeApi(route) {
  const req = route.request(),
    url = new URL(req.url()),
    token = (req.headers().authorization || '').replace('Bearer ', ''),
    method = req.method();
  const result = (status, body, type = 'application/json') =>
    route.fulfill({
      status,
      contentType: type,
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
  try {
    if (url.pathname === '/auth/v1/token') {
      const body = req.postDataJSON();
      if (url.searchParams.get('grant_type') === 'refresh_token')
        return result(200, {
          access_token: 'test-owner',
          refresh_token: 'refresh',
          expires_in: 3600
        });
      if (body.password !== (body.email === 'owner@example.test' ? ownerPassword : 'test-password'))
        return result(400, { error_code: 'invalid_credentials' });
      return result(200, {
        access_token: body.email === 'owner@example.test' ? 'test-owner' : 'test-other',
        refresh_token: 'refresh',
        expires_in: 3600
      });
    }
    if (url.pathname === '/auth/v1/user') {
      if (!['test-owner', 'test-other'].includes(token)) return result(401, {});
      if (method === 'PUT') ownerPassword = req.postDataJSON().password;
      return result(200, {
        id: token === 'test-owner' ? owner : other,
        email: token === 'test-owner' ? 'owner@example.test' : 'other@example.test'
      });
    }
    if (url.pathname === '/auth/v1/recover') return result(200, {});
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.pathname === '/rest/v1/site_admins') {
      const rows = await sqlAs(token, 'select user_id from public.site_admins');
      return result(200, rows.rows);
    }
    if (['/rest/v1/projects', '/rest/v1/journal_entries'].includes(url.pathname)) {
      const table = url.pathname.endsWith('/projects') ? 'projects' : 'journal_entries';
      const rows = await sqlAs(
        token,
        'select * from public.' + table + ' where is_published order by id limit 100'
      );
      return result(200, rows.rows);
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const name = decodeURIComponent(url.pathname.split('workspace-media/')[1]);
      const allowed = (
        await sqlAs(token, 'select public.workspace_media_access($1,$2) as allowed', [
          name,
          method === 'POST'
        ])
      ).rows[0].allowed;
      if (!allowed) return result(403, {});
      if (method === 'POST') {
        files.set(name, { bytes: req.postDataBuffer(), type: req.headers()['content-type'] });
        return result(200, { Key: name });
      }
      if (!files.has(name)) return result(404, {});
      const file = files.get(name);
      return result(200, file.bytes, file.type);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      if (!/^workspace_[a-z_]+$/.test(name)) return result(404, {});
      const body = req.postDataJSON() || {};
      if (failJournal && name === 'workspace_public_list' && body.p_kind === 'entry')
        return result(500, {});
      const keys = Object.keys(body);
      if (keys.some((k) => !/^p_[a-z_]+$/.test(k))) return result(400, {});
      const response = await sqlAs(
        token,
        'select public.' +
          name +
          '(' +
          keys.map((key, i) => key + '=> $' + (i + 1)).join(',') +
          ') as result',
        keys.map((k) => body[k])
      );
      if (loseSave && name === 'workspace_save' && !saveLost) {
        saveLost = true;
        return route.abort('connectionfailed');
      }
      return result(200, response.rows[0].result);
    }
    return result(404, { code: 'PGRST202' });
  } catch (e) {
    return result(e.code === 'PT409' ? 409 : e.code === '42501' ? 403 : 400, {
      code: e.code,
      message: e.message
    });
  }
}
async function context(configured = true, desktopReleases) {
  const context = await browser.newContext();
  const config = configured
    ? {
        supabaseUrl: 'https://workspace-test.supabase.co',
        publishableKey: 'sb_publishable_test',
        useDatabase: true
      }
    : {};
  if (desktopReleases) config.desktopReleases = desktopReleases;
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
  await context.route('**/config.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'window.WORKSPACE_CONFIG=' + JSON.stringify(config)
    })
  );
  await context.route('https://workspace-test.supabase.co/**', routeApi);
  return context;
}
async function login(page, email = 'owner@example.test') {
  await page.goto(base + '/admin.html');
  await page.locator('#login-email').fill(email);
  await page
    .locator('#login-password')
    .fill(email === 'owner@example.test' ? ownerPassword : 'test-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}
async function save(page) {
  await page.locator('#save-item').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
function card(page, id, list = 'project-list') {
  return page.locator('#' + list + ' .admin-item[data-item-id="' + id + '"]');
}
(async () => {
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated;insert into auth.users values('${owner}'),('${other}');`
  );
  await db.exec(fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/002_workspace.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/003_validation.sql'), 'utf8'));
  await db.exec(`insert into site_admins values('${owner}')`);
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost'),
      file = path.resolve(root, '.' + (u.pathname === '/' ? '/index.html' : u.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.html')
            ? 'text/html'
            : 'text/plain'
    );
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  base = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE || chromium.executablePath(),
      headless: true,
      args: ['--no-sandbox']
    });
    const calendarRelease = {
      ready: false,
      downloadUrl: 'https://github.com/psho0324/-/releases/latest/download/MyPlanner-Setup.exe',
      downloadPlatform: 'windows',
      downloadVersion: '0.1.0',
      downloadRequirements: 'Windows 10/11 · 64비트',
      unsigned: true
    };
    const offline = await context(false, { calendar: calendarRelease }),
      offlinePage = await offline.newPage();
    await offlinePage.goto(base + '/');
    await offlinePage.locator('.project-card').waitFor();
    await offlinePage.getByRole('button', { name: '캘린더 앱 다운로드', exact: true }).click();
    await offlinePage.getByRole('heading', { name: '캘린더 앱 다운로드', exact: true }).waitFor();
    assert(await offlinePage.locator('#download-pc-pending').isVisible());
    assert(await offlinePage.locator('#download-pc-pending').isDisabled());
    assert.equal(await offlinePage.locator('#download-pc-link').getAttribute('href'), null);
    assert(!(await offlinePage.locator('#download-unsigned-notice').isVisible()));
    assert.equal(await offlinePage.locator('#download-mobile-badge').textContent(), '지원 준비 중');
    await offlinePage.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await offlinePage
        .locator('#download-dialog')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    );
    await offlinePage.screenshot({ path: '/tmp/calendar-download-mobile.png', fullPage: true });
    await offlinePage.keyboard.press('Escape');
    assert(!(await offlinePage.locator('#download-dialog').isVisible()));
    await offlinePage.getByRole('tab', { name: '다음 실험' }).click();
    assert(await offlinePage.locator('#panel-ideas').isVisible());
    await offline.close();
    const released = await context(false, {
        calendar: { ...calendarRelease, ready: true }
      }),
      releasedPage = await released.newPage();
    await releasedPage.goto(base + '/');
    await releasedPage.getByRole('button', { name: '캘린더 앱 다운로드', exact: true }).click();
    await releasedPage.locator('#download-pc-link').waitFor();
    assert.equal(
      await releasedPage.locator('#download-pc-link').getAttribute('href'),
      calendarRelease.downloadUrl
    );
    assert.equal(await releasedPage.locator('#download-pc-title').textContent(), 'Windows 버전');
    assert.equal(await releasedPage.locator('#download-version').textContent(), '버전 0.1.0');
    assert(await releasedPage.locator('#download-unsigned-notice').isVisible());
    assert.match(
      await releasedPage.locator('#download-unsigned-notice').textContent(),
      /SmartScreen[\s\S]*추가 정보 → 실행/
    );
    await releasedPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await releasedPage
        .locator('#download-dialog')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    );
    await releasedPage.screenshot({
      path: '/tmp/planner-release-download-mobile.png',
      fullPage: true
    });
    await releasedPage.locator('#download-close').click();
    // Explicit administrator download settings win over release defaults, without an unrelated warning.
    await releasedPage.evaluate(() =>
      Object.assign(
        window.projects.find((project) => project.id === 'calendar'),
        {
          downloadUrl: 'https://example.test/custom-installer.exe',
          downloadPlatform: 'windows',
          downloadVersion: '0.2.0',
          downloadRequirements: 'Administrator download settings'
        }
      )
    );
    await releasedPage.getByRole('button', { name: '캘린더 앱 다운로드', exact: true }).click();
    await releasedPage.locator('#download-pc-link').waitFor();
    assert.equal(
      await releasedPage.locator('#download-pc-link').getAttribute('href'),
      'https://example.test/custom-installer.exe'
    );
    assert.equal(await releasedPage.locator('#download-version').textContent(), '버전 0.2.0');
    assert.equal(
      await releasedPage.locator('#download-requirements').textContent(),
      'Administrator download settings'
    );
    assert(!(await releasedPage.locator('#download-unsigned-notice').isVisible()));
    await released.close();
    await db.exec('grant select on public.projects,public.journal_entries to anon,authenticated');
    const previous = await context(),
      previousPage = await previous.newPage();
    await previous.route('**/rpc/workspace_version', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST202' })
      })
    );
    await previousPage.goto(base + '/');
    await previousPage.locator('.project-card').waitFor();
    assert.equal(await previousPage.locator('.project-card').count(), 1);
    await login(previousPage);
    await previousPage.locator('#migration-panel').waitFor();
    assert(!(await previousPage.locator('#dashboard').isVisible()));
    await previous.close();
    await db.exec('revoke all on public.projects,public.journal_entries from anon,authenticated');
    const denied = await context(),
      deniedPage = await denied.newPage();
    await login(deniedPage, 'other@example.test');
    await deniedPage.locator('#notice.error').waitFor();
    assert(!(await deniedPage.locator('#dashboard').isVisible()));
    await denied.close();
    const ownerContext = await context(),
      page = await ownerContext.newPage();
    await login(page);
    await page.locator('#dashboard').waitFor();
    await page.locator('#new-project').click();
    await page.locator('#project-name').fill('Review test');
    await page.locator('#project-description').fill('Brief introduction');
    await page.locator('#project-advanced summary').click();
    await page.locator('#project-id').fill('INVALID SPACE');
    assert.equal(await page.locator('#project-id').evaluate((el) => el.checkValidity()), false);
    await page.locator('#project-id').fill('all');
    await page.locator('#project-category').selectOption('TOOLS');
    await page
      .locator('#project-tags')
      .fill(
        'productivity, calendar, automation, personal, daily, planning, focus, workflow, tools, project'
      );
    await page.locator('#project-url').fill('https://example.test');
    await page.locator('#download-platform').selectOption('windows');
    await page.locator('#download-url').fill('https://example.test/releases/app.exe');
    await page.locator('#download-version').fill('1.2.0');
    await page.locator('#download-requirements').fill('Windows 10 이상 · 테스트용 안내');
    await page.locator('#download-mobile-planned').check();

    await page.locator('#project-note').fill('Detailed description that stays reachable');
    await page.locator('#publish-state').selectOption('published');
    await save(page);
    const visitors = await context(),
      publicPage = await visitors.newPage();
    await publicPage.goto(base + '/');
    await publicPage.locator('.project-card').nth(1).waitFor();
    await publicPage.getByRole('button', { name: 'Review test 다운로드', exact: true }).click();
    await publicPage.getByRole('heading', { name: 'Review test 다운로드', exact: true }).waitFor();
    assert.equal(await publicPage.locator('#download-pc-title').textContent(), 'Windows 버전');
    assert.equal(await publicPage.locator('#download-version').textContent(), '버전 1.2.0');
    assert.equal(
      await publicPage.locator('#download-pc-link').getAttribute('href'),
      'https://example.test/releases/app.exe'
    );
    assert.equal(
      await publicPage.locator('#download-pc-link').getAttribute('rel'),
      'noopener noreferrer'
    );
    assert(!(await publicPage.locator('#download-pc-pending').isVisible()));
    assert(!(await publicPage.locator('#download-unsigned-notice').isVisible()));
    await publicPage.screenshot({ path: '/tmp/download-desktop.png', fullPage: true });
    await publicPage.locator('#download-close').click();
    const projectCard = publicPage
      .locator('.project-card')
      .filter({ has: publicPage.getByRole('heading', { name: 'Review test', exact: true }) });
    await projectCard.getByRole('button', { name: '소개 보기' }).click();
    await publicPage
      .getByText('Detailed description that stays reachable', { exact: true })
      .waitFor();
    assert.match(publicPage.url(), /project=all/);
    await publicPage.keyboard.press('Escape');
    // Closing one detail and opening another must discard the old error response.
    await publicPage.evaluate(() => {
      const api = window.WorkspaceBackend;
      window.auditOriginalDetail = api.publicDetail;
      api.publicDetail = (kind, id) => id === 'calendar'
        ? new Promise((_resolve, reject) => { window.auditRejectDetail = reject; })
        : window.auditOriginalDetail(kind, id);
    });
    await publicPage.locator('.project-card').filter({ has: publicPage.getByRole('heading', { name: '캘린더 앱', exact: true }) }).getByRole('button', { name: '소개 보기' }).click();
    await publicPage.waitForFunction(() => !!window.auditRejectDetail);
    await publicPage.keyboard.press('Escape');
    await projectCard.getByRole('button', { name: '소개 보기' }).click();
    await publicPage.getByText('Detailed description that stays reachable', { exact: true }).waitFor();
    await publicPage.evaluate(() => window.auditRejectDetail(new Error('Old project request failed')));
    await publicPage.waitForTimeout(50);
    assert.equal(await publicPage.locator('#detail-status').textContent(), '',
      'Old project error must not overwrite the current project');
    await publicPage.keyboard.press('Escape');
    // The same guard is required while an old project's image is resolving.
    await publicPage.evaluate(() => {
      const api = window.WorkspaceBackend;
      window.auditOriginalImage = api.resolveImage;
      api.publicDetail = (kind, id) => id === 'calendar'
        ? Promise.resolve({data:{name:'Old image project',description:'Old description',note:'Old note',imageUrl:'https://example.test/old.png'}})
        : window.auditOriginalDetail(kind,id);
      api.resolveImage = value => value === 'https://example.test/old.png'
        ? new Promise(resolve => { window.auditResolveImage = resolve; })
        : window.auditOriginalImage(value);
    });
    await publicPage.locator('.project-card').filter({ has: publicPage.getByRole('heading', { name: '캘린더 앱', exact: true }) }).getByRole('button', { name: '소개 보기' }).click();
    await publicPage.waitForFunction(() => !!window.auditResolveImage);
    await publicPage.keyboard.press('Escape');
    await projectCard.getByRole('button', { name: '소개 보기' }).click();
    await publicPage.getByText('Detailed description that stays reachable', { exact: true }).waitFor();
    await publicPage.evaluate(() => window.auditResolveImage('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'));
    await publicPage.waitForTimeout(50);
    assert.equal(await publicPage.locator('#dialog-images img').count(), 0,
      'Old project image must not appear in another project');
    await publicPage.evaluate(() => { window.WorkspaceBackend.publicDetail=window.auditOriginalDetail;window.WorkspaceBackend.resolveImage=window.auditOriginalImage; });
    await publicPage.keyboard.press('Escape');
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    assert.equal(
      await page.locator('#download-url').inputValue(),
      'https://example.test/releases/app.exe'
    );
    assert.equal(await page.locator('#download-platform').inputValue(), 'windows');
    assert.equal(await page.locator('#download-version').inputValue(), '1.2.0');
    await page.locator('#project-name').fill('Unreleased title');
    await page.locator('#publish-state').selectOption('draft');
    await save(page);
    await publicPage.reload();
    await publicPage.getByRole('heading', { name: 'Review test', exact: true }).waitFor();
    assert.equal(
      await publicPage.getByRole('heading', { name: 'Unreleased title', exact: true }).count(),
      0
    );
    // Reverting every edit must remove the stale browser draft instead of resurrecting it.
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    const originalDescription = await page.locator('#project-description').inputValue();
    await page.locator('#project-description').fill('Cancelled temporary change');
    await page.locator('#project-description').fill(originalDescription);
    await page.keyboard.press('Escape');
    await page.locator('#editor').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#resume-banner').isVisible(), false,
      'Reverted edits must not leave an obsolete recoverable draft');
    // Unsaved content survives cancellation, reload and resume.
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    await page.locator('#project-description').fill('Unsaved local writing');
    page.once('dialog', (d) => d.accept());
    await page.keyboard.press('Escape');
    await page.locator('#editor').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('#dashboard').waitFor();
    await page.locator('#resume-editor').click();
    assert.equal(await page.locator('#project-description').inputValue(), 'Unsaved local writing');
    await page.locator('#publish-state').selectOption('draft');
    await save(page);
    // Two real DB revisions reject a stale edit; typed contents are retained.
    const secondContext = await context(),
      second = await secondContext.newPage();
    await login(second);
    await second.locator('#dashboard').waitFor();
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    await card(second, 'all').getByRole('button', { name: '수정', exact: true }).click();
    await page.locator('#project-description').fill('First tab update');
    await save(page);
    await second.locator('#project-description').fill('Second tab update');
    await second.locator('#save-item').click();
    await second.locator('#editor-error').waitFor();
    assert.match(await second.locator('#editor-error').textContent(), /다른 탭/);
    assert.equal(await second.locator('#project-description').inputValue(), 'Second tab update');
    await second.locator('#copy-conflict').click();
    await save(second);
    await secondContext.close();
    // A committed save with a dropped response is replayed once.
    await page.getByRole('tab', { name: '제작 기록 관리' }).click();
    await page.locator('#new-entry').click();
    await page.locator('#entry-project').selectOption('all');
    await page.locator('#entry-title').fill('Exactly once');
    await page.locator('#entry-summary').fill('Summary');
    await page.locator('#entry-body').fill('Body');
    await page.locator('#publish-state').selectOption('published');
    loseSave = true;
    await page.locator('#save-item').click();
    await page.locator('#editor-error').waitFor();
    await save(page);
    loseSave = false;
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from workspace_items where kind='entry' and published->>'title'='Exactly once'"
        )
      ).rows[0].n,
      1
    );
    await publicPage.reload();
    await publicPage.getByRole('tab', { name: '제작 기록' }).click();
    await publicPage.locator('[data-journal-filter="project:all"]').waitFor();
    await publicPage.locator('[data-journal-filter="project:all"]').click();
    await publicPage.getByRole('heading', { name: 'Exactly once', exact: true }).waitFor();
    await publicPage.waitForFunction(
      () => document.querySelectorAll('.journal-entry').length === 1
    );
    assert.equal(await publicPage.locator('.journal-entry').count(), 1);
    failJournal = true;
    await publicPage.reload();
    await publicPage.getByRole('tab', { name: '제작 기록' }).click();
    await publicPage.locator('#entry-retry').waitFor();
    assert((await publicPage.locator('.project-card').count()) > 0);
    await publicPage.getByRole('tab', { name: '다음 실험' }).click();
    assert(await publicPage.locator('#panel-ideas').isVisible());
    failJournal = false;
    await publicPage.getByRole('tab', { name: '제작 기록' }).click();
    await publicPage.locator('#entry-retry').click();
    // Ideas and image uploads use actual SQL authorization; draft media stays private.
    await page.getByRole('tab', { name: '다음 실험', exact: true }).click();
    await page.locator('#new-idea').click();
    await page.locator('#idea-title').fill('New experiment');
    await page.locator('#idea-summary').fill('A concrete new idea');
    await page.locator('#publish-state').selectOption('published');
    await save(page);
    await publicPage.reload();
    await publicPage.getByRole('tab', { name: '다음 실험' }).click();
    await publicPage.getByRole('heading', { name: 'New experiment', exact: true }).waitFor();
    await page.getByRole('tab', { name: '프로젝트 관리' }).click();
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l5sAAAAASUVORK5CYII=',
      'base64'
    );
    await page
      .locator('#project-upload')
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
    await page
      .getByText('대표 이미지를 첨부했습니다. 저장 후 적용됩니다.', { exact: true })
      .waitFor();
    const imagePath = await page.locator('#project-image').inputValue();
    await save(page);
    assert.equal(
      (
        await sqlAs('', 'select public.workspace_media_access($1,false) as allowed', [
          imagePath.slice(8)
        ])
      ).rows[0].allowed,
      false
    );
    await card(page, 'all').getByRole('button', { name: '수정', exact: true }).click();
    await page.locator('#publish-state').selectOption('published');
    await save(page);
    assert.equal(
      (
        await sqlAs('', 'select public.workspace_media_access($1,false) as allowed', [
          imagePath.slice(8)
        ])
      ).rows[0].allowed,
      true
    );
    await publicPage.reload();
    await publicPage.locator('.project-card').nth(1).waitFor();
    await publicPage.setViewportSize({ width: 390, height: 844 });
    const tagBox = await publicPage
      .locator('.project-card')
      .filter({ has: publicPage.getByRole('heading', { name: 'Unreleased title', exact: true }) })
      .locator('.tags')
      .evaluate((el) => ({ w: el.clientWidth, content: el.scrollWidth }));
    assert(tagBox.content <= tagBox.w + 1);
    await publicPage.screenshot({ path: '/tmp/fixed-public-mobile.png', fullPage: true });
    await card(page, 'all').getByRole('button', { name: '휴지통', exact: true }).click();
    await page.locator('#confirm-delete').click();
    await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: '휴지통', exact: true }).click();
    await card(page, 'all', 'trash-list')
      .getByRole('button', { name: '복원', exact: true })
      .click();
    await page.locator('#confirm-delete').click();
    await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
    assert.equal(
      (await db.query("select published from workspace_items where kind='project' and id='all'"))
        .rows[0].published,
      null
    );
    await page.getByRole('tab', { name: '프로젝트 관리' }).click();
    await card(page, 'all').getByRole('button', { name: '이력', exact: true }).click();
    await page.locator('.history-row').first().waitFor();
    await page.locator('#close-history').click();
    await page.getByRole('tab', { name: '백업·복원' }).click();
    const download = page.waitForEvent('download');
    await page.locator('#export-backup').click();
    const downloaded = await download;
    const backup = JSON.parse(fs.readFileSync(await downloaded.path(), 'utf8'));
    assert.equal(backup.version, 2);
    assert(backup.media.length);
    await page.locator('#import-backup').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup))
    });
    page.once('dialog', (d) => d.accept());
    await page.locator('#restore-backup').click();
    await page.getByText(/개 항목을 새 초안으로 복원했습니다/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    );
    await page.screenshot({ path: '/tmp/fixed-admin-mobile.png', fullPage: true });
    await page.locator('#logout').click();
    await page.locator('#login-panel').waitFor();
    await page.locator('#login-email').fill('owner@example.test');
    await page.locator('#request-reset').click();
    await page.getByText(/등록된 계정이라면/).waitFor();
    await page.goto(
      base + '/admin.html#access_token=test-owner&refresh_token=refresh&type=recovery'
    );
    await page.locator('#recovery-panel').waitFor();
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('#new-password').fill('new-test-password');
    await page.locator('#confirm-password').fill('new-test-password');
    await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await page.locator('#login-panel').waitFor();
    assert.equal(ownerPassword, 'new-test-password');
    assert.deepEqual(errors, []);
    console.log(
      'PASS: browser + real SQL RPC integration: legacy static view, non-admin denial, ID validation, project all filter, download pending/ready dialogs, admin download metadata, public/draft separation, obsolete detail response isolation, reverted draft cleanup, local recovery, revision conflicts, duplicate retry, independent API errors, ideas, private image publication, tag wrapping, trash/restore/history, full image backup/import, mobile, password recovery. Hosted auth/storage transport simulated; no production mutations.'
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
    await db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
