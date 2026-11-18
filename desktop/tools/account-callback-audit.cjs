// Real Chromium callback documents from the native account service.
// Provider responses, browser opening and encryption are synthetic; no live login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createAccountService } = require('../account-service.js');
const { APP_RETURN_URL } = require('../app-return.js');

const PRIVATE_CODE = 'SYNTHETIC_BROWSER_CALLBACK_CODE';
const PRIVATE_DETAIL = 'SYNTHETIC_BROWSER_PROVIDER_DETAIL';
const PRIVATE_FRAGMENT = 'SYNTHETIC_BROWSER_CALLBACK_FRAGMENT';
const ACCESS = 'SYNTHETIC_BROWSER_ACCESS_TOKEN';
const REFRESH = 'SYNTHETIC_BROWSER_REFRESH_TOKEN';
let browser, passed = 0, failed = 0;

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-callback-browser-'));
  const value = { dir, opened: [], transport: [], focusCalls: 0, sessionReadyBeforeFocus: false };
  const sessionFile = path.join(dir, 'planner-account-session.enc');
  let service;
  service = createAccountService({
    userDataDir: dir,
    config: { url: 'https://callback-test.supabase.co', publishableKey: 'sb_publishable_synthetic_browser_key_1234567890' },
    callbackPort: 0,
    appReturnEnabled: options.appReturnEnabled,
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
  const f = fixture(options);
  const context = await browser.newContext();
  const external = [], errors = [];
  // Intercept app-open clicks inside every synthetic browser document. These
  // tests never dispatch to a real OS protocol handler or installed app.
  await context.addInitScript(({ appReturnUrl, throwReturnClick }) => {
    window.__appReturnAttempts = [];
    document.addEventListener('click', event => {
      const link = event.target?.closest?.('a');
      if (link?.getAttribute('href') !== appReturnUrl) return;
      event.preventDefault();
      window.__appReturnAttempts.push({ href: link.getAttribute('href'), trusted: event.isTrusted });
    }, true);
    if (throwReturnClick) {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (...args) {
        if (this.getAttribute('href') !== appReturnUrl) return click.apply(this, args);
        window.__appReturnAttempts.push({ href: appReturnUrl, trusted: false });
        throw new Error('SYNTHETIC_APP_OPEN_FAILURE');
      };
    }
    // A deterministic synthetic visibility transition triggers the actual
    // completion script. It is not evidence of Windows/Edge app activation.
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility });
    window.__hideSyntheticDocument = () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    };
  }, { appReturnUrl: APP_RETURN_URL, throwReturnClick: !!options.throwReturnClick });
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

async function blockedSuccess(f, context, hide = true) {
  const page = await context.newPage();
  const callback = f.callback({ code: PRIVATE_CODE, hint: PRIVATE_DETAIL });
  const response = await page.goto(callback.href);
  await page.waitForFunction(() => window.__appReturnAttempts.length === 1);
  assert.equal(await page.evaluate(() => window.__closeAttempts), 0, 'A visible completion page must survive an app-open prompt');
  if (hide) {
    await page.evaluate(() => window.__hideSyntheticDocument());
    await page.waitForFunction(() => window.__closeAttempts === 1);
  }
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
  await scenario('Script-opened popup closes after a simulated hidden visibility event, after storing the session', {}, async ({ f, context }) => {
    const opener = await context.newPage();
    await opener.setContent('<button id="open" type="button">Open synthetic login</button>');
    await opener.evaluate(url => { document.querySelector('#open').onclick = () => window.open(url, 'synthetic-planner-login'); }, f.callback({ code: PRIVATE_CODE }).href);
    const popupPromise = opener.waitForEvent('popup');
    await opener.locator('#open').click();
    const popup = await popupPromise;
    await popup.waitForFunction(() => window.__appReturnAttempts.length === 1);
    assert.equal(popup.isClosed(), false, 'Visible popup must keep its app-open fallback');
    await popup.evaluate(() => window.__hideSyntheticDocument()).catch(error => { if (!/closed/i.test(error.message)) throw error; });
    if (!popup.isClosed()) await popup.waitForEvent('close');
    assert.equal(popup.isClosed(), true);
    assert.equal(opener.isClosed(), false);
    assert.equal(f.service.getState().authenticated, true);
    assert.equal(f.focusCalls, 1); assert.equal(f.sessionReadyBeforeFocus, true);
    assert.equal(f.transport.length, 1);
  });
  await scenario('Blocked automatic app opening retains the fixed return link and a user click requests the same credential-free URL', { blockClose: true }, async ({ f, context }) => {
    const { page } = await blockedSuccess(f, context, false);
    const link = page.locator('#open-planner');
    assert.equal(await link.getAttribute('href'), APP_RETURN_URL);
    assert.equal(await link.getAttribute('rel'), 'noreferrer');
    assert.equal(await link.innerText(), '플래너로 돌아가기');
    await page.setViewportSize({ width: 360, height: 640 });
    assert.equal(await page.locator('meta[name="viewport"]').getAttribute('content'), 'width=device-width, initial-scale=1');
    const button = await link.boundingBox();
    assert(button && button.height >= 48 && button.width >= 200, 'Return action must remain easy to see and tap');
    assert(button.x >= 0 && button.x + button.width <= 360, 'Return action must fit a narrow screen');
    const target = new URL(await link.getAttribute('href'));
    assert.equal(target.search, ''); assert.equal(target.hash, '');
    assert.equal(target.username, ''); assert.equal(target.password, '');
    assert.match(await page.locator('body').innerText(), /앱이 자동으로 열리지 않으면/);
    assert.match(await page.locator('body').innerText(), /작업 표시줄/);
    await link.click();
    assert.deepEqual(await page.evaluate(() => window.__appReturnAttempts), [
      { href: APP_RETURN_URL, trusted: false }, { href: APP_RETURN_URL, trusted: true },
    ]);
    assert.equal(await page.evaluate(() => window.__closeAttempts), 0);
    assert.equal(f.transport.length, 1, 'App opening must not repeat the token exchange');
  });
  await scenario('An automatic app-open exception preserves login and the visible manual return link', { blockClose: true, throwReturnClick: true }, async ({ f, context }) => {
    const { page } = await blockedSuccess(f, context, false);
    assert.equal(await page.locator('#open-planner').getAttribute('href'), APP_RETURN_URL);
    assert(!(await page.locator('body').innerText()).includes('SYNTHETIC_APP_OPEN_FAILURE'));
    assert.equal(await page.evaluate(() => window.__closeAttempts), 0);
    assert.equal(f.service.getState().error, '');
    await page.evaluate(() => window.__hideSyntheticDocument());
    await page.waitForFunction(() => window.__closeAttempts === 1);
  });
  await scenario('Disabled app return keeps an isolated login in its own app without any public protocol request', { blockClose: true, appReturnEnabled: false }, async ({ f, context }) => {
    const page = await context.newPage();
    const response = await page.goto(f.callback({ code: PRIVATE_CODE }).href);
    await page.waitForFunction(() => location.pathname === '/auth/complete');
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('a').count(), 0);
    const html = await page.content();
    for (const forbidden of [APP_RETURN_URL, 'open-planner', '.click()', PRIVATE_CODE, ACCESS, REFRESH]) assert(!html.includes(forbidden));
    assert.deepEqual(await page.evaluate(() => window.__appReturnAttempts), []);
    assert.equal(await page.evaluate(() => window.__closeAttempts), 0);
    assert.match(await page.locator('body').innerText(), /로그인을 시작한 앱으로 돌아가/);
    assert.equal(f.service.getState().authenticated, true); assert.equal(f.service.getState().error, '');
    assert.equal(f.focusCalls, 1); assert.equal(f.sessionReadyBeforeFocus, true); assert.equal(f.transport.length, 1);
    await page.evaluate(() => window.__hideSyntheticDocument());
    await page.waitForFunction(() => window.__closeAttempts === 1);
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
  await scenario('Success CSP permits only nonce-authorized script and styling and blocks injected code and CSS', { blockClose: true }, async ({ f, context }) => {
    const { page, response } = await blockedSuccess(f, context);
    const csp = response.headers()['content-security-policy'];
    const nonce = /script-src\s+'nonce-([^']+)'/.exec(csp)?.[1];
    assert(nonce, 'Success page needs a nonce-authorized script');
    assert(csp.includes("default-src 'none'")); assert(!csp.includes('unsafe-inline')); assert(!csp.includes('unsafe-eval'));
    for (const directive of ['base-uri', 'form-action', 'connect-src']) assert(csp.includes(directive + " 'none'"));
    assert.equal(await page.locator('script').count(), 1);
    assert.equal(await page.locator('script').evaluate(element => element.nonce), nonce);
    assert(csp.includes("style-src 'nonce-" + nonce + "'"));
    assert.equal(await page.locator('style').count(), 1);
    assert.equal(await page.locator('style').evaluate(element => element.nonce), nonce);
    await page.evaluate(() => { const script = document.createElement('script'); script.textContent = 'window.__untrustedCallbackScript = true'; document.body.append(script); });
    await page.waitForFunction(() => window.__callbackViolations.some(value => value.startsWith('script-src')));
    assert.equal(await page.evaluate(() => window.__untrustedCallbackScript), undefined);
    await page.evaluate(() => { const style = document.createElement('style'); style.textContent = 'body { --callback-injected: yes; }'; document.head.append(style); });
    await page.waitForFunction(() => window.__callbackViolations.some(value => value.startsWith('style-src')));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--callback-injected')), '');
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
    assert.deepEqual(await page.evaluate(() => window.__appReturnAttempts), []);
  });
})().catch(error => { failed++; console.error(error.stack); }).finally(async () => {
  if (browser) await browser.close();
  console.log(`Account callback browser journeys: ${passed} passed, ${failed} failed; Chromium with synthetic provider/storage only.`);
  if (failed) process.exitCode = 1;
});
