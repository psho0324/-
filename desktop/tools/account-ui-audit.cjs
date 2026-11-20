// Actual CSP renderer with a synthetic native bridge. No production auth or mail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../renderer');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(path.join(root, name))) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(root, name)));
});
const guest = { auth: { configured: true, authenticated: false, pending: false, user: null }, sync: { connected: false, pending: 0 } };
const connected = { auth: { configured: true, authenticated: true, pending: false, user: { id: '11111111-1111-4111-8111-111111111111', email: 'synthetic@example.invalid' } }, sync: { connected: true, status: 'idle', pending: 0, lastSyncAt: '2026-11-13T01:00:00Z', conflictCount: 0 } };
let browser, passed = 0, failed = 0;
async function scenario(name, options, run) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1200, height: 900 }, locale: 'ko-KR', colorScheme: options.dark ? 'dark' : 'light' });
  const page = await context.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(({ state, noApi, hold, dark, testBuild }) => {
    window.__persisted = { events: [], todos: [{ id: 'todo-fixture', title: 'Synthetic original', done: false, due: null, priority: 1, categoryId: null, projectId: null, memo: '' }], projects: [], categories: [], goalRecords: [], goalDays: [], settings: { taskTrackingSince: '2026-01-01', theme: dark ? 'dark' : 'light' } };
    window.__calls = []; window.__faults = {}; window.__syncListeners = [];
    window.__accountState = structuredClone(state);
    const listeners = [];
    window.__emitAccount = value => { window.__accountState = structuredClone(value); for (const callback of listeners) callback(structuredClone(value)); };
    window.__emitSync = packet => { for (const callback of window.__syncListeners) callback(structuredClone(packet)); };
    window.storage = {
      load: async () => structuredClone(window.__persisted),
      save: async value => { window.__persisted = structuredClone(value); return true; },
      info: async () => ({ dataFile: 'synthetic/planner-data.json', dataDir: 'synthetic', defaultDir: 'synthetic' }),
      listBackups: async () => [], onExternalChange() {},
      onSyncedChange: callback => { window.__syncListeners.push(callback); return () => {}; },
    };
    window.plannerApp = { getVersion: async () => '0.1.2', getBuildInfo: async () => ({ accountTestBuild: !!testBuild, autoStartAllowed: !testBuild, targetVersion: testBuild ? '0.1.3' : '' }) };
    if (noApi) return;
    const call = (method, args) => { window.__calls.push({ method, args }); if (window.__faults[method]) throw Error(window.__faults[method]); };
    window.plannerAccount = {
      getState: async () => {
        const snapshot = structuredClone(window.__accountState);
        if (hold && !window.__released) await new Promise(resolve => { window.__releaseState = () => { window.__released = true; resolve(); }; });
        return snapshot;
      },
      onState: callback => { listeners.push(callback); return () => { listeners.splice(listeners.indexOf(callback), 1); }; },
      signInGoogle: async () => { call('google'); window.__emitAccount({ ...window.__accountState, auth: { ...window.__accountState.auth, pending: true, error: '' } }); return { pending: true }; },
      cancelSignIn: async () => { call('cancel'); window.__emitAccount({ ...window.__accountState, auth: { ...window.__accountState.auth, pending: false } }); },
      sendEmailCode: async email => { call('send', email); return { sent: true }; },
      verifyEmailCode: async value => { call('verify', value); window.__emitAccount({ auth: { configured: true, authenticated: true, pending: false, user: { id: '11111111-1111-4111-8111-111111111111', email: value.email } }, sync: { connected: false, pending: 0 } }); },
      connect: async value => { call('connect', value); if (window.__holdConnect) await new Promise(resolve => { window.__releaseConnect = resolve; }); window.__emitAccount({ ...window.__accountState, sync: { connected: true, status: 'idle', pending: 0 } }); },
      syncNow: async () => { call('sync'); },
      exportConflicts: async () => { call('export'); return { canceled: false }; },
      resolveRecovery: async value => { call('recovery', value); window.__emitAccount({ ...window.__accountState, sync: { connected: false, status: 'guest', pending: 0 } }); },
      signOut: async () => { call('signout'); window.__emitAccount({ auth: { configured: true, authenticated: false, pending: false, user: null }, sync: { connected: false, pending: 0 } }); },
    };
  }, { state: options.state || guest, noApi: options.noApi, hold: options.hold, dark: options.dark, testBuild: options.testBuild });
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForSelector('#homeBody .home');
    await page.locator('[data-nav="settings"]').click();
    if (!options.hold) await page.waitForFunction(() => document.querySelector('#account-status').textContent !== '로그인 없이 사용 중' || window.__accountState.auth.configured);
    await run(page);
    assert.deepEqual(errors, [], 'Uncaught renderer errors');
    assert.deepEqual(external, [], 'Renderer attempted an external request');
    passed++; console.log('PASS', name);
  } catch (error) { failed++; console.error('FAIL', name, error.stack, JSON.stringify(errors)); }
  finally { await context.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  await scenario('Private account-test build is labeled and cannot select startup or shared folders', { testBuild: true }, async page => {
    await page.locator('#app-build-note').waitFor({ state: 'visible' });
    assert.match(await page.locator('#app-build-note').innerText(), /0\.1\.3 후보/);
    assert.equal(await page.locator('#app-version').innerText(), 'v0.1.2');
    assert.match(await page.title(), /계정 연결 테스트/);
    for (const id of ['set-autostart', 'set-folder', 'set-folderReset']) assert(await page.locator('#' + id).isDisabled());
    await page.locator('[data-nav="home"]').click(); await page.locator('[data-nav="settings"]').click();
    assert(await page.locator('#set-autostart').isDisabled());
    assert.match(await page.locator('#set-where').innerText(), /테스트 전용 폴더/);
  });
  await scenario('No account bridge keeps guest use available without network', { noApi: true }, async page => {
    assert.match(await page.locator('#account-status').innerText(), /로그인 없이/);
    assert(await page.locator('#account-google').isDisabled());
    await page.locator('[data-nav="todos"]').click();
    await page.locator('#todo-create').click(); await page.locator('#td-title').fill('Synthetic offline task');
    await page.locator('#todoForm button[type=submit]').click();
    await page.waitForFunction(() => window.__persisted.todos.some(todo => todo.title === 'Synthetic offline task'));
  });
  await scenario('Unconfigured service explains optional setup without exposing key fields', { state: { auth: { configured: false }, sync: {} } }, async page => {
    assert.match(await page.locator('#account-status').innerText(), /계정 동기화 준비 중/);
    assert(await page.locator('#account-login').isHidden());
    assert(await page.locator('#account-google').isDisabled());
    assert.equal(await page.locator('#set-accountCard input[type=password]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  });
  await scenario('Google authentication remains opt-in and can be cancelled', {}, async page => {
    await page.locator('#account-google').click();
    await page.locator('#account-loginPending').waitFor({ state: 'visible' });
    assert(await page.locator('#account-login').isHidden());
    await page.locator('#account-cancelSignIn').click();
    await page.locator('#account-login').waitFor({ state: 'visible' });
    assert.deepEqual(await page.evaluate(() => window.__calls.map(call => call.method)), ['google', 'cancel']);
  });
  for (const [code, expected] of [
    ['ACCOUNT_GOOGLE_CANCELLED', '구글 로그인을 취소했어요. 다시 시도하거나 로그인 없이 계속 사용할 수 있어요.'],
    ['ACCOUNT_GOOGLE_CONFIG', '구글 로그인 설정을 확인해야 해요. 이 PC의 자료는 계속 사용할 수 있어요.'],
    ['ACCOUNT_GOOGLE_TEMPORARY', '구글 로그인 서버에 잠시 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.'],
    ['ACCOUNT_GOOGLE_FAILED', '구글 로그인을 완료하지 못했어요. 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.'],
  ]) await scenario(`Google callback ${code} is visible, ends waiting and permits a fresh attempt`, {}, async page => {
    const before = await page.evaluate(() => structuredClone(window.__persisted));
    await page.locator('#account-google').click();
    await page.locator('#account-loginPending').waitFor({ state: 'visible' });
    await page.evaluate(({ state, code }) => window.__emitAccount({ ...state, auth: { ...state.auth, pending: false, error: code } }), { state: guest, code });
    await page.locator('#account-message').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#account-message').innerText(), expected);
    assert(await page.locator('#account-message').evaluate(element => element.classList.contains('err')));
    assert(await page.locator('#account-loginPending').isHidden());
    assert(await page.locator('#account-google').isEnabled());
    assert.equal(await page.locator('#account-status').innerText(), '로그인 없이 사용 중');
    assert.deepEqual(await page.evaluate(() => window.__persisted), before);
    assert.deepEqual(await page.evaluate(() => window.__calls.map(call => call.method)), ['google']);
    await page.locator('[data-nav="todos"]').click();
    assert.match(await page.locator('#todoList').innerText(), /Synthetic original/);
    await page.locator('[data-nav="settings"]').click();
    assert.equal(await page.locator('#account-message').innerText(), expected);
    await page.locator('#account-google').click();
    await page.locator('#account-loginPending').waitFor({ state: 'visible' });
    assert(await page.locator('#account-message').isHidden());
    assert.equal(await page.evaluate(() => window.__accountState.auth.error), '');
    assert.deepEqual(await page.evaluate(() => window.__calls.map(call => call.method)), ['google', 'google']);
    await page.evaluate(state => window.__emitAccount({ ...state, sync: { connected: false, pending: 0 } }), connected);
    await page.locator('#account-import').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#account-status').innerText(), '로그인 완료 · 자료 연결 전');
    assert(await page.locator('#account-message').isHidden());
    assert(await page.locator('#account-connect').isDisabled());
    assert(!(await page.locator('#account-importConsent').isChecked()));
  });
  await scenario('Google guidance uses the fixed code and never renders raw provider diagnostics', {}, async page => {
    const raw = 'SYNTHETIC_PROVIDER_DIAGNOSTIC https://example.invalid/?code=SYNTHETIC_PROVIDER_CODE <img src=x onerror=alert(1)>';
    for (const [code, expected] of [
      ['ACCOUNT_GOOGLE_CONFIG', '구글 로그인 설정을 확인해야 해요. 이 PC의 자료는 계속 사용할 수 있어요.'],
      ['ACCOUNT_GOOGLE_TEMPORARY', '구글 로그인 서버에 잠시 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.'],
    ]) {
      await page.evaluate(({ state, raw, code }) => window.__emitAccount({ ...state, auth: { ...state.auth, pending: false, error: { code, message: raw } } }), { state: guest, raw, code });
      await page.locator('#account-message').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#account-message').innerText(), expected);
      assert(!(await page.locator('#set-accountCard').innerText()).includes('SYNTHETIC_PROVIDER'));
      assert(!(await page.locator('#set-accountCard').innerHTML()).includes('example.invalid/?code='));
      assert.equal(await page.locator('#set-accountCard img').count(), 0);
    }
    await page.evaluate(state => window.__emitAccount({ ...state, auth: { ...state.auth, error: 'unknown untrusted server details SYNTHETIC_PROVIDER_DIAGNOSTIC' } }), guest);
    assert.equal(await page.locator('#account-message').innerText(), '계정 연결을 완료하지 못했어요. 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.');
    assert(!(await page.locator('#set-accountCard').innerText()).includes('SYNTHETIC_PROVIDER'));
  });
  await scenario('Email verification never uploads local data before explicit consent', {}, async page => {
    await page.locator('#account-emailSend').click();
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    await page.locator('#account-email').fill('first@example.invalid'); await page.locator('#account-emailSend').click();
    await page.locator('#account-codeForm').waitFor({ state: 'visible' });
    await page.locator('#account-code').fill('123456');
    await page.locator('#account-email').fill('second@example.invalid');
    assert(await page.locator('#account-codeForm').isHidden()); assert.equal(await page.locator('#account-code').inputValue(), '');
    await page.locator('#account-emailSend').click(); await page.locator('#account-code').fill('654321');
    await page.locator('#account-codeVerify').click();
    await page.locator('#account-import').waitFor({ state: 'visible' });
    assert(await page.locator('#account-connect').isDisabled());
    assert(!(await page.locator('#account-importConsent').isChecked()));
    assert(!(await page.evaluate(() => window.__calls.some(call => call.method === 'connect'))));
    await page.locator('#account-importConsent').check(); await page.locator('#account-connect').click();
    await page.locator('#account-syncNow').waitFor({ state: 'visible' });
    const calls = await page.evaluate(() => window.__calls);
    assert.deepEqual(calls.find(call => call.method === 'verify').args, { email: 'second@example.invalid', code: '654321' });
    assert.deepEqual(calls.filter(call => call.method === 'connect'), [{ method: 'connect', args: { importLocal: true } }]);
    assert.equal(await page.locator('#account-code').inputValue(), '');
  });
  await scenario('Background state changes are quiet and untrusted account text is escaped', { state: connected }, async page => {
    await page.evaluate(state => window.__emitAccount(state), { ...connected, auth: { ...connected.auth, user: { ...connected.auth.user, email: '<img src=x onerror=alert(1)>@example.invalid' } }, sync: { ...connected.sync, status: 'offline', pending: 2, conflictCount: 1 } });
    assert.match(await page.locator('#account-detail').innerText(), /2건/);
    assert.match(await page.locator('#account-conflicts').innerText(), /1건/);
    assert.equal(await page.locator('#set-accountCard img').count(), 0);
    assert.match(await page.locator('#account-user').innerText(), /<img/);
    assert(await page.locator('#toast').isHidden());
    assert(await page.locator('#account-lastSync').isVisible());
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  });
  await scenario('Expired login leaves local tasks usable and does not request a fresh import', { state: { ...connected, auth: { ...connected.auth, authenticated: false, needsLogin: true } } }, async page => {
    assert.match(await page.locator('#account-status').innerText(), /다시 로그인/);
    assert(await page.locator('#account-login').isVisible());
    assert(await page.locator('#account-import').isHidden());
    assert(await page.locator('#account-syncNow').isDisabled());
    await page.locator('[data-nav="todos"]').click();
    assert.match(await page.locator('#todoList').innerText(), /Synthetic original/);
  });
  await scenario('Raw auth and sync errors never expose server tokens in settings', {}, async page => {
    await page.evaluate(() => { window.__faults.send = 'raw-server-secret-token-bearer-credentials'; });
    await page.locator('#account-email').fill('synthetic@example.invalid'); await page.locator('#account-emailSend').click();
    await page.waitForFunction(() => document.querySelector('#account-message').textContent.includes('보내지 못했어요'));
    assert(!(await page.locator('#set-accountCard').innerText()).includes('raw-server-secret-token'));
    await page.evaluate(state => window.__emitAccount(state), { ...connected, auth: { ...connected.auth, error: 'raw-auth-secret-token' }, sync: { ...connected.sync, error: 'raw-sync-secret-token' } });
    assert(!(await page.locator('#set-accountCard').innerText()).includes('secret-token'));
  });
  await scenario('Logout requires deliberate inline confirmation and clears account identity', { state: connected }, async page => {
    await page.locator('#account-signOut').click(); assert(await page.locator('#account-signOutPrompt').isVisible());
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    await page.locator('#account-signOutCancel').click(); assert(await page.locator('#account-signOutPrompt').isHidden());
    await page.locator('#account-signOut').click(); await page.locator('#account-signOutConfirm').click();
    await page.locator('#account-user').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.__calls.map(call => call.method)), ['signout']);
    assert(await page.locator('#account-signOutPrompt').isHidden());
  });
  await scenario('Coordinator retry and mismatched account states cannot claim successful sync', { state: { ...connected, sync: { ...connected.sync, status: 'retry', pending: 1, error: 'ACCOUNT_NETWORK' } } }, async page => {
    assert.match(await page.locator('#account-status').innerText(), /연결 대기/);
    assert.match(await page.locator('#account-message').innerText(), /인터넷 연결/);
    await page.evaluate(state => window.__emitAccount(state), { ...connected, auth: { ...connected.auth, user: { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.invalid' } }, sync: { ...connected.sync, status: 'account-mismatch', needsLogin: true, user: connected.auth.user } });
    assert.match(await page.locator('#account-status').innerText(), /다른 계정/);
    assert.match(await page.locator('#account-user').innerText(), /자료 계정: synthetic@example.invalid/);
    assert.match(await page.locator('#account-user').innerText(), /로그인 계정: other@example.invalid/);
    assert(await page.locator('#account-syncNow').isDisabled());
    assert(await page.locator('#account-import').isHidden());
  });
  await scenario('Current native error takes priority over earlier success feedback', {}, async page => {
    await page.locator('#account-email').fill('synthetic@example.invalid'); await page.locator('#account-emailSend').click();
    await page.locator('#account-codeForm').waitFor({ state: 'visible' });
    await page.evaluate(state => window.__emitAccount(state), { ...guest, auth: { ...guest.auth, error: 'ACCOUNT_NETWORK' } });
    assert.match(await page.locator('#account-message').innerText(), /인터넷 연결/);
    assert(!(await page.locator('#account-message').innerText()).includes('보냈어요'));
  });
  await scenario('Preserved conflict copies can be exported only by deliberate action', { state: { ...connected, sync: { ...connected.sync, conflictCount: 2 } } }, async page => {
    assert(await page.locator('#account-exportConflicts').isVisible());
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    await page.locator('#account-exportConflicts').click();
    await page.waitForFunction(() => window.__calls.some(call => call.method === 'export'));
    assert.deepEqual(await page.evaluate(() => window.__calls.map(call => call.method)), ['export']);
  });
  await scenario('Interrupted profile transition requires explicit local recovery without upload', { state: { ...connected, sync: { ...connected.sync, status: 'recovery-required' } } }, async page => {
    assert(await page.locator('#account-recovery').isVisible());
    assert(await page.locator('#account-syncNow').isDisabled());
    assert(await page.locator('#account-signOut').isDisabled());
    assert(await page.locator('#account-import').isHidden());
    await page.locator('#account-resolveRecovery').click();
    await page.locator('#account-recovery').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.__calls), [{ method: 'recovery', args: { keepAsGuest: true } }]);
    assert(await page.locator('#account-connect').isDisabled());
  });
  await scenario('An older getState reply cannot overwrite a newer native account event', { hold: true }, async page => {
    await page.evaluate(state => window.__emitAccount(state), connected);
    assert.match(await page.locator('#account-status').innerText(), /자동 동기화/);
    await page.evaluate(() => window.__releaseState());
    await page.waitForTimeout(30);
    assert.match(await page.locator('#account-status').innerText(), /자동 동기화/);
  });
  await scenario('Native sync preserves a local pending edit and does not close a draft dialog', { state: connected }, async page => {
    assert.equal(await page.evaluate(() => typeof window.PlannerSync.mergeVisible), 'function');
    await page.locator('[data-nav="calendar"]').click(); await page.locator('[data-view="month"]').click();
    await page.waitForFunction(() => window.__persisted.settings.defaultView === 'month');
    await page.locator('[data-nav="home"]').click(); await page.locator('.mc-day.today').click();
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.todos[0].memo = 'Remote change while viewing a day';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    assert(await page.locator('[data-view="day"]').evaluate(button => button.classList.contains('active')));
    assert.equal(await page.evaluate(() => window.__persisted.settings.defaultView), 'month');
    await page.locator('[data-nav="todos"]').click();
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted);
      const next = structuredClone(base); next.todos[0].title = 'Synthetic remote title';
      document.querySelector('#todoList input[type=checkbox]').click();
      window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.waitForFunction(() => window.__persisted.todos[0].done && window.__persisted.todos[0].title === 'Synthetic remote title');
    await page.locator('#todo-create').click(); await page.locator('#td-title').fill('Unsaved synthetic draft');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.todos[0].memo = 'Remote memo';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    assert(await page.locator('#todoDialog').isVisible()); assert.equal(await page.locator('#td-title').inputValue(), 'Unsaved synthetic draft');
    assert(await page.locator('#toast').isHidden());
  });
  await scenario('Stale task draft stays open and cannot overwrite a remote edit or deletion', { state: connected }, async page => {
    await page.locator('[data-nav="todos"]').click();
    await page.locator('#todoList .todo-title').first().click(); await page.locator('#td-memo').fill('Unsubmitted local memo');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.todos[0].title = 'New remote title';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.locator('#todoForm button[type=submit]').click();
    assert(await page.locator('#todoDialog').isVisible()); assert.equal(await page.locator('#td-memo').inputValue(), 'Unsubmitted local memo');
    assert.match(await page.locator('#td-error').innerText(), /다른 곳에서 변경되거나 삭제/);
    assert.equal(await page.evaluate(() => window.__persisted.todos[0].title), 'New remote title');
    await page.locator('#td-cancel').click(); await page.locator('#todoList .todo-title').first().click();
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.todos = [];
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.locator('#todoForm button[type=submit]').click();
    assert(await page.locator('#todoDialog').isVisible()); assert.equal(await page.evaluate(() => window.__persisted.todos.length), 0);
  });
  await scenario('Unrelated sync and JSON key reordering preserve an existing task edit', { state: connected }, async page => {
    await page.locator('[data-nav="todos"]').click(); await page.locator('#todoList .todo-title').first().click();
    await page.locator('#td-memo').fill('Saved local memo');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base);
      next.todos[0] = Object.fromEntries(Object.entries(next.todos[0]).reverse());
      next.todos.push({ id: 'remote-other', title: 'Different remote task', done: false, due: null, priority: 1, memo: '', categoryId: null, projectId: null });
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.locator('#todoForm button[type=submit]').click();
    await page.locator('#todoDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__persisted.todos.find(todo => todo.id === 'todo-fixture')?.memo === 'Saved local memo');
    assert(await page.evaluate(() => window.__persisted.todos.some(todo => todo.id === 'remote-other')));
  });
  await scenario('Existing goal draft cannot overwrite a newer remote goal', { state: connected }, async page => {
    await page.locator('[data-nav="goals"]').click(); await page.locator('#goal-create').click();
    await page.locator('#pj-title').fill('Synthetic goal'); await page.locator('#projForm button[type=submit]').click();
    await page.waitForFunction(() => window.__persisted.projects.length === 1);
    await page.locator('.proj-head').first().click(); await page.locator('#pj-memo').fill('Unsaved goal memo');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.projects[0].title = 'Remote goal';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.locator('#projForm button[type=submit]').click();
    assert(await page.locator('#projDialog').isVisible()); assert.equal(await page.locator('#pj-memo').inputValue(), 'Unsaved goal memo');
    assert.match(await page.locator('#pj-error').innerText(), /다른 곳에서 변경되거나 삭제/);
    assert.equal(await page.evaluate(() => window.__persisted.projects[0].title), 'Remote goal');
  });
  await scenario('Existing event draft cannot overwrite a newer remote event', { state: connected }, async page => {
    await page.locator('#quickOpen').click(); await page.locator('#quickInput').fill('09:00 Synthetic event'); await page.locator('#quickOk').click();
    await page.waitForFunction(() => window.__persisted.events.length === 1);
    await page.locator('[data-nav="calendar"]').click(); await page.locator('.chip').filter({ hasText: 'Synthetic event' }).first().click();
    await page.locator('#ev-memo').fill('Unsaved event memo');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.events[0].title = 'Remote event';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    await page.locator('#eventForm button[type=submit]').click();
    assert(await page.locator('#eventDialog').isVisible()); assert.equal(await page.locator('#ev-memo').inputValue(), 'Unsaved event memo');
    assert.match(await page.locator('#ev-error').innerText(), /다른 곳에서 변경되거나 삭제/);
    assert.equal(await page.evaluate(() => window.__persisted.events[0].title), 'Remote event');
  });
  await scenario('A remote sync cancels an armed backup replacement confirmation', { state: connected }, async page => {
    await page.locator('#set-importBox').fill(JSON.stringify({ events: [], todos: [], projects: [], categories: [], settings: {} }));
    await page.locator('#set-import').click();
    assert.match(await page.locator('#set-import').innerText(), /한 번 더/);
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = structuredClone(base); next.todos[0].memo = 'Latest remote backup state';
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'sync' });
    });
    assert.equal(await page.locator('#set-import').innerText(), '가져오기');
    await page.locator('#set-import').click();
    assert.match(await page.locator('#set-import').innerText(), /한 번 더/);
    assert.equal(await page.evaluate(() => window.__persisted.todos.length), 1);
  });
  await scenario('Changed backend is shown as paused while local tasks remain usable', { state: { ...connected, sync: { ...connected.sync, status: 'backend-mismatch', backendChanged: true, error: { code: 'PLANNER_SYNC_BACKEND_CHANGED', message: 'Untrusted raw diagnostic' } } } }, async page => {
    assert.match(await page.locator('#account-status').innerText(), /서버 설정 변경.*중지/);
    assert(await page.locator('#account-syncNow').isDisabled());
    assert.match(await page.locator('#account-detail').innerText(), /자료는 그대로 보관/);
    assert(!(await page.locator('#set-accountCard').innerText()).includes('Untrusted raw diagnostic'));
    await page.locator('[data-nav="todos"]').click(); assert.match(await page.locator('#todoList').innerText(), /Synthetic original/);
  });
  await scenario('Explicit profile transfer freezes shortcuts only until the native switch completes', { state: { ...connected, sync: { connected: false, pending: 0 } } }, async page => {
    await page.evaluate(() => { window.__holdConnect = true; });
    await page.locator('#account-importConsent').check(); await page.locator('#account-connect').click();
    await page.locator('#account-transition').waitFor({ state: 'visible' });
    assert(await page.locator('.app').evaluate(element => element.inert));
    await page.keyboard.press('q'); assert(!(await page.locator('#quickDialog').isVisible()));
    await page.evaluate(() => window.__releaseConnect());
    await page.locator('#account-transition').waitFor({ state: 'detached' });
    assert(!(await page.locator('.app').evaluate(element => element.inert)));
    await page.locator('[data-nav="todos"]').click(); await page.locator('#todo-create').click();
    await page.locator('#td-title').fill('After completed profile transfer'); await page.locator('#todoForm button[type=submit]').click();
    await page.waitForFunction(() => window.__persisted.todos.some(todo => todo.title === 'After completed profile transfer'));
  });
  await scenario('An open new draft cannot be saved into a different account profile', { state: connected }, async page => {
    await page.locator('[data-nav="todos"]').click(); await page.locator('#todo-create').click();
    await page.locator('#td-title').fill('Private source-profile draft');
    await page.evaluate(() => {
      const base = structuredClone(window.__persisted), next = { ...base, todos: [] };
      window.__persisted = next; window.__emitSync({ baseData: base, data: next, reason: 'profile' });
    });
    await page.locator('#todoForm button[type=submit]').click();
    assert(await page.locator('#todoDialog').isVisible());
    assert.equal(await page.locator('#td-title').inputValue(), 'Private source-profile draft');
    assert.match(await page.locator('#td-error').innerText(), /계정 자료가 전환/);
    assert.equal(await page.evaluate(() => window.__persisted.todos.length), 0);
    await page.locator('#td-cancel').click(); await page.locator('#todo-create').click();
    await page.locator('#td-title').fill('Target-profile draft'); await page.locator('#todoForm button[type=submit]').click();
    await page.waitForFunction(() => window.__persisted.todos.some(todo => todo.title === 'Target-profile draft'));
  });
  for (const width of [320, 390]) await scenario(`Account controls fit ${width}px dark settings`, { state: connected, viewport: { width, height: 900 }, dark: true }, async page => {
    await page.evaluate(state => window.__emitAccount(state), guest);
    await page.locator('#account-email').fill('long-synthetic-email-for-layout@example.invalid'); await page.locator('#account-emailSend').click();
    await page.locator('#account-codeForm').waitFor({ state: 'visible' });
    assert(await page.locator('#set-accountCard').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const controls = await page.locator('#set-accountCard input:visible, #set-accountCard button:visible').evaluateAll(elements => elements.map(el => ({ x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right })));
    assert(controls.every(box => box.x >= 0 && box.right <= width + 1));
    assert.equal(await page.locator('html').getAttribute('data-resolved-theme'), 'dark');
  });
  console.log(`Account UI journeys: ${passed} passed, ${failed} failed; native API mocked, no production requests.`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
.finally(async () => { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); });
