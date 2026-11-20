// Authentication stays in the main process. The renderer receives status only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { APP_RETURN_URL } = require('./app-return.js');

const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function validateConfig(value) {
  if (!value || !value.url || !value.publishableKey) return null;
  let url;
  try { url = new URL(value.url); } catch { return null; }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !['', '/'].includes(url.pathname)) return null;
  const key = value.publishableKey;
  if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key) || key.startsWith('sb_secret_')) return null;
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(key);
  if (!publicKey) {
    try { publicKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { /* Public keys only. */ }
  }
  return publicKey ? { url: url.origin, publishableKey: key } : null;
}

function googleCallbackFailure(params) {
  // Specific structured codes take precedence over free-form descriptions.
  // Generic server wrappers alone do not prove a configuration problem. Only
  // fixed categories/messages may leave this function, never server text.
  const classify = value => {
    const code = (value || '').trim().toLowerCase();
    if (['access_denied', 'user_cancelled', 'user_canceled', 'cancelled', 'canceled'].includes(code)) return 'CANCELLED';
    if (['invalid_client', 'unauthorized_client', 'unsupported_provider'].includes(code)) return 'CONFIG';
    if (['unexpected_failure', 'server_error'].includes(code)) return 'TEMPORARY';
    return null;
  };
  const codes = [classify(params.get('error_code')), classify(params.get('error'))];
  let category = codes.find(code => code && code !== 'TEMPORARY');
  if (!category) {
    const description = params.get('error_description') || '';
    if (/\binvalid_client\b|\bunauthorized_client\b|\bunsupported_provider\b|\bclient secret is invalid\b/i.test(description)) category = 'CONFIG';
    else if (/\baccess_denied\b|\buser[ _-]cancel(?:led|ed)\b/i.test(description)) category = 'CANCELLED';
    else if (codes.includes('TEMPORARY') || /\bserver_error\b|\bunexpected_failure\b/i.test(description)) category = 'TEMPORARY';
    else category = 'FAILED';
  }
  const browser = {
    CANCELLED: 'Google 로그인을 취소했습니다. 앱으로 돌아가 다시 시도해 주세요.',
    CONFIG: 'Google 로그인 설정을 확인해야 합니다. 앱으로 돌아가 주세요.',
    TEMPORARY: 'Google 로그인 서버에 잠시 문제가 생겼습니다. 앱으로 돌아가 잠시 뒤 다시 시도해 주세요.',
    FAILED: 'Google 로그인을 완료하지 못했습니다. 앱으로 돌아가 다시 시도해 주세요.',
  }[category];
  return { code: 'ACCOUNT_GOOGLE_' + category, browser };
}

async function request(url, options) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw fail('ACCOUNT_RESPONSE', '동기화 응답이 너무 커요. 자료는 이 PC에 보관되어 있어요.');
    const reader = response.body?.getReader();
    let length = 0;
    const chunks = [];
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw fail('ACCOUNT_RESPONSE', '동기화 응답이 너무 커요. 자료는 이 PC에 보관되어 있어요.'); }
      chunks.push(Buffer.from(value));
    }
    let body = {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) try { body = JSON.parse(text); } catch { throw fail('ACCOUNT_RESPONSE', '서버 응답을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.'); }
    return { status: response.status, body };
  } catch (error) {
    if (error.code?.startsWith('ACCOUNT_')) throw error;
    throw fail('ACCOUNT_NETWORK', '연결을 기다리고 있어요. 이 PC에서는 계속 사용할 수 있어요.');
  }
}

function createAccountService({ userDataDir, config, configFile = path.join(__dirname, 'account-config.json'), safeStorage, openExternal, transport = request, now = Date.now, callbackPort = 42883, loginTimeout = 5 * 60 * 1000, onGoogleSignInSuccess = () => {}, appReturnEnabled = true }) {
  if (!config) try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { config = null; }
  const backend = validateConfig(config);
  const sessionFile = path.join(userDataDir, 'planner-account-session.enc');
  const listeners = new Set();
  let session = null, pending = null, error = '', needsLogin = false, refresh = null, disposed = false, authEpoch = 0;
  let emailSentAt = 0, sentEmail = '', emailRequest = null;
  const secure = () => !!safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  const state = () => ({ configured: !!backend, backendId: backend?.url || null, authenticated: !!session, user: session ? clone(session.user) : null, needsLogin, pending: !!pending, error });
  function emit() { for (const cb of listeners) try { cb(state()); } catch { /* A view cannot interrupt credential storage. */ } }
  function ready() {
    if (disposed) throw fail('ACCOUNT_CLOSED', '앱을 다시 실행해 주세요.');
    if (!backend) throw fail('ACCOUNT_SETUP', '계정 동기화를 준비 중이에요. 지금은 이 PC에 저장해 사용할 수 있어요.');
    if (!secure()) throw fail('ACCOUNT_STORAGE', '이 PC에서 로그인 정보를 안전하게 보관할 수 없어 계정 연결을 중단했어요. 오프라인 사용은 계속할 수 있어요.');
  }
  function storeSession(value) {
    const user = value?.user;
    if (!validId(user?.id) || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384 || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384) throw fail('ACCOUNT_SESSION', '로그인 결과를 확인하지 못했어요. 다시 로그인해 주세요.');
    const expires = Number(value.expires_at) * 1000 || now() + (Math.max(30, Number(value.expires_in) || 3600) * 1000);
    if (!Number.isFinite(expires) || expires <= 0) throw fail('ACCOUNT_SESSION', '로그인 유효 시간을 확인하지 못했어요. 다시 로그인해 주세요.');
    if (session && session.user.id !== user.id) throw fail('ACCOUNT_CHANGED', '다른 계정을 연결하려면 먼저 로그아웃해 주세요.');
    const next = { origin: backend.url, access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expires, user: { id: user.id, email: typeof user.email === 'string' ? user.email.slice(0, 320) : '' } };
    if (!secure()) throw fail('ACCOUNT_STORAGE', '로그인 정보를 안전하게 보관할 수 없어 계정 연결을 중단했어요.');
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(sessionFile + '.tmp', safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
      fs.renameSync(sessionFile + '.tmp', sessionFile);
    } catch { throw fail('ACCOUNT_STORAGE', '로그인 정보를 저장하지 못했어요. 폴더 권한을 확인한 뒤 다시 연결해 주세요.'); }
    session = next; error = ''; needsLogin = false; emit();
    return state();
  }
  if (backend && fs.existsSync(sessionFile)) {
    try {
      if (!secure()) throw Error('secure storage unavailable');
      if (fs.statSync(sessionFile).size > 100000) throw Error('oversized session');
      const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionFile)));
      if (value.origin !== backend.url || !validId(value?.user?.id) || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384 || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 16384 || !Number.isFinite(value.expires_at) || value.expires_at <= 0) throw Error('invalid session');
      session = { origin: value.origin, access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at, user: { id: value.user.id, email: typeof value.user.email === 'string' ? value.user.email.slice(0, 320) : '' } };
    } catch { error = '저장된 로그인 정보를 열지 못했어요. 이 PC의 자료는 유지되며 다시 로그인할 수 있어요.'; needsLogin = true; }
  }
  async function call(endpoint, body, bearer) {
    ready();
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw fail('ACCOUNT_REQUEST', '한 번에 동기화할 자료가 너무 많아요. 자료는 이 PC에 남아 있어요.');
    let response;
    try { response = await transport(backend.url + endpoint, { method: 'POST', headers: { apikey: backend.publishableKey, 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: json }); }
    catch (e) { if (e.code?.startsWith('ACCOUNT_')) throw e; throw fail('ACCOUNT_NETWORK', '연결을 기다리고 있어요. 이 PC에서는 계속 사용할 수 있어요.'); }
    if (!response || !Number.isInteger(response.status)) throw fail('ACCOUNT_RESPONSE', '서버 응답을 확인하지 못했어요.');
    if (response.status < 200 || response.status >= 300) {
      const code = response.status === 401 || response.status === 403 ? 'ACCOUNT_AUTH' : response.status === 429 ? 'ACCOUNT_RATE' : response.status === 404 ? 'ACCOUNT_SCHEMA' : 'ACCOUNT_SERVER';
      const message = code === 'ACCOUNT_RATE' ? '요청이 많아 잠시 기다리고 있어요. 잠시 뒤 다시 시도해 주세요.' : code === 'ACCOUNT_SCHEMA' ? '계정 동기화 서버 설정을 확인해야 해요. 이 PC에서는 계속 사용할 수 있어요.' : code === 'ACCOUNT_AUTH' ? '계정 연결을 확인해야 해요. 다시 로그인해 주세요.' : '서버에 연결하지 못했어요. 이 PC의 자료는 유지됩니다.';
      throw Object.assign(fail(code, message), { status: response.status });
    }
    return response.body;
  }
  async function ensureSession(force = false) {
    ready();
    if (!session) throw fail('ACCOUNT_AUTH', '계정을 연결하면 다른 기기와 동기화할 수 있어요.');
    if (!force && session.expires_at > now() + 60000 && !needsLogin) return session;
    if (refresh) return refresh;
    const previous = session;
    const epoch = authEpoch;
    refresh = (async () => {
      try {
        const next = await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: previous.refresh_token });
        if (session !== previous || disposed || epoch !== authEpoch) throw fail('ACCOUNT_CHANGED', '계정 연결 상태가 바뀌었어요.');
        // Refreshed user identities may never switch the locally connected account.
        if (next?.user?.id !== previous.user.id) throw fail('ACCOUNT_SESSION', '계정 확인 결과가 달라 연결을 중단했어요.');
        storeSession(next); return session;
      } catch (e) {
        if (session === previous && (e.code === 'ACCOUNT_AUTH' || e.status === 400 || e.code === 'ACCOUNT_SESSION')) { needsLogin = true; error = '로그인이 만료되었어요. 자료는 이 PC에 보관되며 다시 로그인하면 동기화를 이어갈 수 있어요.'; emit(); }
        throw e;
      } finally { refresh = null; }
    })();
    return refresh;
  }
  function cancelSignIn() {
    authEpoch++;
    const active = pending; pending = null;
    if (active) {
      clearTimeout(active.timer);
      active.closing = true;
      try { active.server.close(); } catch {}
      // HTTP close()/closeIdleConnections() do not cover a browser's accepted
      // TCP preconnect that has not sent a complete request yet. Such a socket
      // must not survive to send a later attempt to this old nonce/listener.
      for (const [socket, connection] of active.connections) {
        if (socket.destroyed || connection.responses.size) continue;
        if (connection.seenRequest) socket.end();
        else socket.destroy();
      }
    }
    emit(); return state();
  }
  async function signInGoogle() {
    ready();
    if (pending) return state();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('hex');
    const active = { server: null, timer: null, closing: false, connections: new Map() };
    const trackConnection = socket => {
      let connection = active.connections.get(socket);
      if (!connection) {
        connection = { seenRequest: false, responses: new Set() };
        active.connections.set(socket, connection);
        socket.once('close', () => active.connections.delete(socket));
      }
      return connection;
    };
    const server = http.createServer(async (req, res) => {
      const socket = req.socket;
      const connection = trackConnection(socket);
      connection.seenRequest = true;
      connection.responses.add(res);
      const responseDone = () => {
        if (!connection.responses.delete(res)) return;
        // Preserve every in-flight response, including a successful completion
        // document, until it has flushed. Then finish the owned socket normally.
        if (active.closing && !connection.responses.size && !socket.destroyed) socket.end();
      };
      res.once('finish', responseDone);
      res.once('close', responseDone);
      // Each attempt owns a new listener; pooled connections must not reach an old one.
      const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', Connection: 'close' }); res.end(text); };
      const replySuccess = () => {
        const scriptNonce = crypto.randomBytes(16).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
        });
        // Never interpolate provider data or credentials into this completion page.
        // Only this fixed app-open URL is shared with the browser. It carries no
        // auth state; browser policy can block both app opening and tab closing.
        // Keep the visible page alive while an app-open permission prompt may be
        // waiting. Once the document is hidden, closing is still best effort.
        // Isolated private builds and source runs must not open the separately
        // installed public app. Only an explicitly enabled capability adds it.
        const canReturn = appReturnEnabled === true;
        const returnStyle = canReturn ? `
#open-planner { display: block; min-height: 48px; padding: 12px 16px; border-radius: 10px; background: #314b36; color: #fff; font-weight: 700; text-align: center; text-decoration: none; }
#open-planner:focus-visible { outline: 3px solid #8ca873; outline-offset: 4px; }
@media (prefers-color-scheme: dark) { #open-planner { background: #bdd4a0; color: #1e2a20; } }
` : '';
        const returnAction = canReturn ? `<p><a id="open-planner" href="${APP_RETURN_URL}" rel="noreferrer">플래너로 돌아가기</a></p>
<p class="guidance">앱이 자동으로 열리지 않으면 위 버튼을 눌러 주세요. 브라우저가 묻는 경우 ‘열기’를 선택해 주세요.</p>
<p class="guidance">버튼으로도 열리지 않으면 작업 표시줄의 내 플래너를 눌러 주세요.</p>` : '<p class="guidance">로그인을 시작한 앱으로 돌아가 주세요. 작업 표시줄에서 실행 중인 앱을 선택할 수 있습니다.</p>';
        const returnScript = canReturn ? "try { document.getElementById('open-planner').click(); } catch {} " : '';
        res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>로그인 완료 · 내 플래너</title>
<style nonce="${scriptNonce}">
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f5f6f2; color: #253227; }
main { width: min(100%, 440px); padding: 32px; border: 1px solid #dce2d5; border-radius: 20px; background: #fff; }
h1 { margin: 0 0 16px; font-size: 1.75rem; }
p { margin: 16px 0 0; line-height: 1.65; }
.guidance { font-size: .92rem; color: #586752; }
@media (prefers-color-scheme: dark) {
  body { background: #151c17; color: #eef3e9; }
  main { background: #202b23; border-color: #43513d; }
  .guidance { color: #c1cbb9; }
}
${returnStyle}
</style></head><body><main><h1>로그인 완료</h1>
<p>내 플래너에 로그인했습니다.</p>
${returnAction}
<p class="guidance">이 탭이 자동으로 닫히지 않으면 직접 닫아 주세요.</p>
</main><script nonce="${scriptNonce}">try { history.replaceState(null, '', '/auth/complete'); } catch {} const closeWhenHidden = () => { if (document.visibilityState === 'hidden') { try { window.close(); } catch {} } }; document.addEventListener('visibilitychange', closeWhenHidden); ${returnScript}closeWhenHidden();</script></body></html>`);
      };
      let u;
      try { if (req.url.length > 8192) throw Error('oversized callback'); u = new URL(req.url, 'http://127.0.0.1'); }
      catch { return reply(400, '로그인 요청을 확인하지 못했습니다.'); }
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${server.address()?.port}` || u.pathname !== '/auth/callback' || u.searchParams.get('state') !== nonce || pending !== active) return reply(400, '로그인 요청을 확인하지 못했습니다. 앱에서 다시 시도해 주세요.');
      if (active.consuming) return reply(409, '로그인을 확인 중입니다. 앱으로 돌아가 주세요.');
      const code = u.searchParams.get('code');
      if (!code || code.length > 2048 || ['error', 'error_code', 'error_description'].some(key => u.searchParams.has(key))) {
        const failure = googleCallbackFailure(u.searchParams);
        error = failure.code;
        reply(400, failure.browser);
        cancelSignIn();
        return;
      }
      active.consuming = true;
      try {
        const value = await call('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
        if (pending !== active || disposed) throw fail('ACCOUNT_CANCELLED', '로그인이 취소되었어요.');
        storeSession(value); replySuccess(); error = '';
        // Focusing the app must never turn a completed login into an auth error.
        try { onGoogleSignInSuccess(); } catch {}
      } catch (e) { if (pending === active) error = e.message; reply(400, '로그인을 완료하지 못했습니다. 앱으로 돌아가 다시 시도해 주세요.'); }
      finally { if (pending === active) cancelSignIn(); }
    });
    server.on('connection', socket => {
      trackConnection(socket);
      if (active.closing) socket.destroy();
    });
    active.server = server; pending = active; error = ''; emit();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(callbackPort, '127.0.0.1', resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback?state=${nonce}`;
      const auth = new URL(backend.url + '/auth/v1/authorize');
      auth.searchParams.set('provider', 'google'); auth.searchParams.set('redirect_to', redirect);
      auth.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); auth.searchParams.set('code_challenge_method', 's256');
      active.timer = setTimeout(() => { if (pending === active) { error = '로그인 시간이 지났어요. 다시 연결해 주세요.'; cancelSignIn(); } }, loginTimeout);
      active.timer.unref?.();
      await openExternal(auth.href);
      return state();
    } catch {
      const message = '로그인 창을 열지 못했어요. 다른 로그인 창을 닫고 다시 시도해 주세요.';
      if (pending === active) { error = message; cancelSignIn(); }
      throw fail('ACCOUNT_BROWSER', message);
    }
  }
  async function sendEmailCode(email) {
    ready();
    if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('ACCOUNT_EMAIL', '이메일 주소를 확인해 주세요.');
    if (emailRequest) throw fail('ACCOUNT_RATE', '인증번호를 요청 중이에요. 잠시 기다려 주세요.');
    if (sentEmail === email.trim().toLowerCase() && now() - emailSentAt < 60000) throw fail('ACCOUNT_RATE', '인증번호를 보냈어요. 잠시 기다린 뒤 다시 요청해 주세요.');
    emailRequest = call('/auth/v1/otp', { email: email.trim(), create_user: true });
    try { await emailRequest; sentEmail = email.trim().toLowerCase(); emailSentAt = now(); error = ''; emit(); return state(); }
    finally { emailRequest = null; }
  }
  async function verifyEmailCode({ email, code } = {}) {
    ready();
    if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof code !== 'string' || !/^\d{6,10}$/.test(code)) throw fail('ACCOUNT_EMAIL', '이메일과 인증번호를 확인해 주세요.');
    const epoch = authEpoch;
    const result = await call('/auth/v1/verify', { email: email.trim(), token: code, type: 'email' });
    if (authEpoch !== epoch || disposed) throw fail('ACCOUNT_CANCELLED', '로그인 요청이 취소되었어요.');
    return storeSession(result);
  }
  async function rpc(name, params, { accountId } = {}) {
    if (!['planner_sync', 'planner_sync_list_conflicts'].includes(name)) throw fail('ACCOUNT_RPC', '허용되지 않은 동기화 요청이에요.');
    const epoch = authEpoch;
    if (accountId !== undefined && session?.user.id !== accountId) throw fail('ACCOUNT_CHANGED', '계정 연결 상태가 바뀌었어요.');
    const current = await ensureSession();
    const stillCurrent = () => { if (epoch !== authEpoch || disposed || !session || session.user.id !== current.user.id || (accountId !== undefined && session.user.id !== accountId)) throw fail('ACCOUNT_CANCELLED', '계정 연결 상태가 바뀌었어요.'); };
    stillCurrent();
    try { const result = await call('/rest/v1/rpc/' + name, params, current.access_token); stillCurrent(); return result; }
    catch (e) {
      stillCurrent();
      if (e.code !== 'ACCOUNT_AUTH') throw e;
      const renewed = await ensureSession(true); stillCurrent();
      const result = await call('/rest/v1/rpc/' + name, params, renewed.access_token); stillCurrent(); return result;
    }
  }
  async function signOut() {
    authEpoch++;
    cancelSignIn();
    try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch { throw fail('ACCOUNT_STORAGE', '로그인 정보를 지우지 못했어요. 폴더 권한을 확인하고 다시 로그아웃해 주세요.'); }
    const previous = session; session = null; needsLogin = false; error = ''; emit();
    if (previous && backend) void call('/auth/v1/logout?scope=local', {}, previous.access_token).catch(() => {});
    return state();
  }
  return {
    getState: state, onState: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    signInGoogle, cancelSignIn, sendEmailCode, verifyEmailCode, rpc, signOut,
    dispose() { cancelSignIn(); disposed = true; listeners.clear(); },
  };
}

module.exports = { createAccountService, validateConfig };
