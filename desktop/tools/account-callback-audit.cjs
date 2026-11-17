// Real Chromium callback documents from the native account service.
// Provider responses, browser opening and encryption are synthetic; no live login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createAccountService } = require('../account-service.js');

const PRIVATE_CODE = 'SYNTHETIC_BROWSER_CALLBACK_CODE';
const PRIVATE_DETAIL = 'SYNTHETIC_BROWSER_PROVIDER_DETAIL';
const PRIVATE_FRAGMENT = 'SYNTHETIC_BROWSER_CALLBACK_FRAGMENT';
const ACCESS = 'SYNTHETIC_BROWSER_ACCESS_TOKEN';
const REFRESH = 'SYNTHETIC_BROWSER_REFRESH_TOKEN';
let browser, passed = 0, failed = 0;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-callback-browser-'));
  const value = { dir, opened: [], transport: [], focusCalls: 0, sessionReadyBeforeFocus: false };
  const sessionFile = path.join(dir, 'planner-account-session.enc');
  let service;
  service = createAccountService({
    userDataDir: dir,
    config: { url: 'https://callback-test.supabase.co', publishableKey: 'sb_publishable_synthetic_browser_key_1234567890' },
    callbackPort: 0,
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'synthetic-test',
      encryptString: () => Buffer.from('SYNTHETIC_ENCRYPTED_SESSION'),
    },
    openExternal: async url => { value.opened.push(url); },
    onGoogleSignInSuccess: () => {
      value.focusCalls++;
      value.sessionReadyBeforeFocus = service.getState().authenticated && fs.existsSync(sessionFile);
    },
    transport: async (url, options) => {
      value.transport.push({ endpoint: new URL(url).pathname + new URL(url).search, method: options.method });
      return { status: 200, body: {
        access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600,
        user: { id: '11111111-1111-4111-8111-111111111111', email: 'callback-test@example.invalid' },
      } };
    },
  });
  value.service = service;
  value.callback = params => {
    const auth = new URL(value.opened.at(-1));
    const callback = new URL(auth.searchParams.get('redirect_to'));
    for (const [key, text] of Object.entries(params)) callback.searchParams.set(key, text);
    callback.hash = PRIVATE_FRAGMENT;
    return callback;
  };
  value.dispose = () => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); };
  return value;
}

async function scenario(name, options, run) {
  const f = fixture();
  const context = await browser.newContext();
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push('blocked external request'); return route.abort(); }
    return route.continue();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  if (options.blockClose) await context.addInitScript(() => {
    window.__closeAttempts = 0;
    window.close = () => { window.__closeAttempts++; };
    window.__callbackViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__callbackViolations.push(event.effectiveDirective));
  });
  try {
    await f.service.signInGoogle();
    await run({ f, context });
    assert.deepEqual(errors, [], 'Uncaught callback page errors');
    assert.deepEqual(external, [], 'Callback attempted an external request');
    passed++; console.log('PASS', name);
  } catch (error) {
    failed++; console.error('FAIL', name, error.stack);
  } finally {
    await context.close();
    f.dispose();
  }
}

async function blockedSuccess(f, context) {
  const page = await context.newPage();
  const callback = f.callback({ code: PRIVATE_CODE, hint: PRIVATE_DETAIL });
  const response = await page.goto(callback.href);
  await page.waitForFunction(() => window.__closeAttempts === 1);
  assert.equal(response.status(), 200);
  assert.equal(f.service.getState().authenticated, true);
  assert.equal(f.focusCalls, 1);
  assert.equal(f.sessionReadyBeforeFocus, true);
  assert.equal(f.transport.length, 1);
  assert.equal(f.transport[0].endpoint, '/auth/v1/token?grant_type=pkce');
  return { page, response, callback };
}

(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox'],
  });
  await scenario('Successful callback closes a script-opened login popup after storing the session', {}, async ({ f, context }) => {
    const opener = await context.newPage();
    await opener.setContent('<button id="open" type="button">Open synthetic login</button>');
    await opener.evaluate(url => { document.querySelector('#open').onclick = () => window.open(url, 'synthetic-planner-login'); }, f.callback({ code: PRIVATE_CODE }).href);
    const popupPromise = opener.waitForEvent('popup');
    await opener.locator('#open').click();
    const popup = await popupPromise;
    if (!popup.isClosed()) await popup.waitForEvent('close');
    assert.equal(popup.isClosed(), true);
    assert.equal(opener.isClosed(), false);
    assert.equal(f.service.getState().authenticated, true);
    assert.equal(f.focusCalls, 1); assert.equal(f.sessionReadyBeforeFocus, true);
    assert.equal(f.transport.length, 1);
  });
  await scenario('Blocked automatic close leaves fixed completion guidance and removes callback query and fragment', { blockClose: true }, async ({ f, context }) => {
    const { page, response, callback } = await blockedSuccess(f, context);
    const clean = new URL(page.url());
    assert.equal(clean.pathname, '/auth/complete'); assert.equal(clean.search, ''); assert.equal(clean.hash, '');
    assert.match(await page.locator('body').innerText(), /로그인/);
    assert.match(await page.locator('body').innerText(), /닫/);
    const html = await page.content();
    for (const raw of [PRIVATE_CODE, PRIVATE_DETAIL, PRIVATE_FRAGMENT, ACCESS, REFRESH, callback.searchParams.get('state')]) assert(!html.includes(raw), 'Callback body contains synthetic private data');
    assert(!html.includes('http://')); assert(!html.includes('https://'));
    const headers = response.headers();
    assert.match(headers['content-type'], /^text\/html/);
    assert.equal(headers['cache-control'], 'no-store'); assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers.connection, 'close');
  });
  await scenario('Success CSP runs only the nonce-authorized completion script and blocks injected inline code', { blockClose: true }, async ({ f, context }) => {
    const { page, response } = await blockedSuccess(f, context);
    const csp = response.headers()['content-security-policy'];
    const nonce = /script-src\s+'nonce-([^']+)'/.exec(csp)?.[1];
    assert(nonce, 'Success page needs a nonce-authorized script');
    assert(csp.includes("default-src 'none'")); assert(!csp.includes('unsafe-inline')); assert(!csp.includes('unsafe-eval'));
    for (const directive of ['base-uri', 'form-action', 'connect-src']) assert(csp.includes(directive + " 'none'"));
    assert.equal(await page.locator('script').count(), 1);
    assert.equal(await page.locator('script').evaluate(element => element.nonce), nonce);
    await page.evaluate(() => { const script = document.createElement('script'); script.textContent = 'window.__untrustedCallbackScript = true'; document.body.append(script); });
    await page.waitForFunction(() => window.__callbackViolations.some(value => value.startsWith('script-src')));
    assert.equal(await page.evaluate(() => window.__untrustedCallbackScript), undefined);
  });
  for (const [error, expected, category] of [
    ['invalid_client', /설정/, 'CONFIG'],
    ['access_denied', /취소/, 'CANCELLED'],
    ['unrecognized_error', /완료하지 못/, 'FAILED'],
  ]) await scenario(`Failed callback ${category} remains visible without running close or focus`, { blockClose: true }, async ({ f, context }) => {
    const page = await context.newPage();
    const response = await page.goto(f.callback({ error, error_description: PRIVATE_DETAIL }).href);
    assert.equal(response.status(), 400); assert.match(response.headers()['content-type'], /^text\/plain/);
    assert.match(await page.locator('body').innerText(), expected);
    assert(!(await page.content()).includes(PRIVATE_DETAIL));
    assert.equal(await page.evaluate(() => window.__closeAttempts), 0);
    assert.equal(f.service.getState().error, 'ACCOUNT_GOOGLE_' + category);
    assert.equal(f.service.getState().authenticated, false); assert.equal(f.service.getState().pending, false);
    assert.equal(f.transport.length, 0); assert.equal(f.focusCalls, 0);
  });
})().catch(error => { failed++; console.error(error.stack); }).finally(async () => {
  if (browser) await browser.close();
  console.log(`Account callback browser journeys: ${passed} passed, ${failed} failed; Chromium with synthetic provider/storage only.`);
  if (failed) process.exitCode = 1;
});
