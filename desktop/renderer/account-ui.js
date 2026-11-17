// Optional native account controls. Tokens and network requests stay in main.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const card = $('set-accountCard');
  if (!card) return;
  const api = window.plannerAccount;
  const available = !!api && typeof api.getState === 'function';
  let current = { auth: { configured: false, authenticated: false }, sync: {} };
  let busy = false, googlePending = false, cancelBusy = false, codeRequested = false;
  let codeEmail = '', consentAccount = null, feedback = null, actionSeq = 0, stateSeq = 0;
  let profileLock = null;
  const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const needsLogin = (auth, sync) => !!auth.needsLogin || !!sync.needsLogin || ['login-required', 'account-mismatch'].includes(sync.status);
  const setText = (id, text) => { $(id).textContent = text; };
  const visible = (id, yes) => { $(id).hidden = !yes; };
  function safeError(error, fallback) {
    // Do not copy raw IPC/server errors, URLs, or credentials into the document.
    const value = typeof error === 'string' ? error : String(error?.code || error?.message || '');
    if (value === 'ACCOUNT_GOOGLE_CANCELLED') return '구글 로그인을 취소했어요. 다시 시도하거나 로그인 없이 계속 사용할 수 있어요.';
    if (value === 'ACCOUNT_GOOGLE_CONFIG') return '구글 로그인 설정을 확인해야 해요. 이 PC의 자료는 계속 사용할 수 있어요.';
    if (value === 'ACCOUNT_GOOGLE_FAILED') return '구글 로그인을 완료하지 못했어요. 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.';
    if (/not.configured|setup.required|account_setup|provider.disabled|oauth_provider|unsupported_provider/i.test(value)) return '계정 연결을 아직 준비하고 있어요. 지금처럼 로그인 없이 사용할 수 있어요.';
    if (/planner_sync_folder/i.test(value)) return '계정 동기화를 사용하려면 저장 위치를 기본 위치로 바꿔 주세요. 기존 자료는 먼저 백업해 주세요.';
    if (/planner_sync_backend_changed/i.test(value)) return '계정 서버 설정이 바뀌어 동기화를 멈췄어요. 기존 서버 설정을 확인해 주세요. 기기 자료는 보관돼 있어요.';
    if (/otp_expired|invalid.otp|invalid.code|code.invalid|invalid.token|인증번호/i.test(value)) return '인증번호가 올바르지 않거나 만료됐어요. 번호를 확인하거나 새로 받아 주세요.';
    if (/rate.limit|account_rate|too.many|over_.*rate|429/i.test(value)) return '요청이 많아 잠시 기다려야 해요. 잠시 후 다시 시도해 주세요.';
    if (/network|offline|fetch|econn|timeout|timed.out|인터넷|네트워크/i.test(value)) return '인터넷 연결을 확인한 뒤 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.';
    if (/needs.login|session.expired|account_session|unauthorized|로그인.*필요/i.test(value)) return '다시 로그인하면 동기화를 이어갈 수 있어요. 이 PC의 자료는 계속 사용할 수 있어요.';
    if (/sync.journal|journal.write|account_storage|enospc|eacces|eperm|저장.*실패|쓰기.*권한/i.test(value)) return '연결 정보를 저장하지 못했어요. 이 PC의 저장 상태와 폴더 권한을 확인한 뒤 다시 시도해 주세요.';
    if (/account_browser/i.test(value)) return '로그인 브라우저를 열지 못했어요. 다시 시도하거나 이메일 인증번호로 로그인해 주세요.';
    if (/account_cancelled/i.test(value)) return '로그인을 취소했어요. 로그인 없이 계속 사용할 수 있어요.';
    return fallback;
  }
  function message(text, tone = '') { feedback = text ? { text, tone } : null; render(); }
  function stateLabel(auth, sync) {
    if (!available) return ['preview', '로그인 없이 사용 중'];
    if (sync.status === 'recovery-required') return ['recovery', '중단된 자료 전환의 복구 확인이 필요해요'];
    if (!auth.configured) return ['setup', '계정 동기화 준비 중'];
    if (sync.status === 'backend-mismatch') return ['waiting', '계정 서버 설정 변경으로 동기화 중지'];
    if (sync.status === 'account-mismatch') return ['login', '현재 자료와 다른 계정으로 로그인했어요'];
    if (needsLogin(auth, sync)) return ['login', '다시 로그인하면 동기화를 이어갈 수 있어요'];
    if (googlePending || auth.pending) return ['login', 'Google 로그인 대기 중'];
    if (!auth.authenticated) return ['guest', '로그인 없이 사용 중'];
    if (!sync.connected) return ['ready', '로그인 완료 · 자료 연결 전'];
    if (sync.status === 'syncing') return ['syncing', '동기화 중'];
    if (['offline', 'retry', 'retrying', 'error', 'waiting', 'auth-required'].includes(sync.status)) return ['waiting', '이 PC에 저장됨 · 동기화 연결 대기'];
    if (count(sync.pending)) return ['pending', `이 PC에 저장됨 · 동기화 대기 ${count(sync.pending)}건`];
    return ['connected', '자동 동기화 사용 중'];
  }
  function render() {
    const auth = current.auth || {}, sync = current.sync || {};
    const signedInUser = auth.user && typeof auth.user === 'object' ? auth.user : null;
    const user = sync.connected && sync.user && typeof sync.user === 'object' ? sync.user : signedInUser;
    const userId = typeof user?.id === 'string' ? user.id : null;
    if (userId !== consentAccount) {
      consentAccount = userId;
      $('account-importConsent').checked = false;
      visible('account-signOutPrompt', false);
    }
    if (auth.authenticated || auth.error) googlePending = false;
    const pendingLogin = googlePending || auth.pending === true;
    const recovering = sync.status === 'recovery-required';
    const requiresLogin = needsLogin(auth, sync);
    const canLogin = available && auth.configured && !recovering && (!auth.authenticated || requiresLogin);
    const canAct = available && auth.configured && !recovering && sync.status !== 'backend-mismatch' && !busy && !pendingLogin;
    const [status, label] = stateLabel(auth, sync);
    card.dataset.accountReady = available ? 'true' : 'false';
    card.setAttribute('aria-busy', busy ? 'true' : 'false');
    $('account-status').dataset.state = status;
    setText('account-status', label);
    const email = typeof user?.email === 'string' ? user.email : '';
    setText('account-user', email ? `자료 계정: ${email}` + (sync.status === 'account-mismatch' && typeof signedInUser?.email === 'string' ? ` · 로그인 계정: ${signedInUser.email}` : '') : '');
    visible('account-user', !!email);
    let detail = '일정은 먼저 이 PC에 저장해요. 계정 연결은 선택할 수 있어요.';
    if (!available) detail = '이 화면에서는 로그인 없이 사용할 수 있어요. 계정 연결은 설치한 PC 앱에서 지원해요.';
    else if (recovering) detail = '현재 자료와 계정별 사본을 보존하고 있어요. 복구를 정리하기 전에는 계정에 자동으로 올리지 않아요.';
    else if (!auth.configured) detail = '계정 연결을 준비하고 있어요. 일정 작성·로컬 저장·알림은 로그인 없이 사용할 수 있어요.';
    else if (sync.status === 'backend-mismatch') detail = '연결한 서버 설정이 바뀌어 자동 동기화를 멈췄어요. 기존 서버 설정을 확인해 주세요. 이 PC의 자료는 그대로 보관돼 있어요.';
    else if (sync.status === 'account-mismatch') detail = '현재 자료의 계정으로 다시 로그인하거나 로그아웃해 연결을 정리해 주세요. 현재 자료는 다른 계정에 자동으로 올리지 않아요.';
    else if (requiresLogin) detail = '로그인이 필요해도 기기에 저장한 자료와 오프라인 사용은 유지돼요.';
    else if (sync.connected) detail = count(sync.pending) ? `인터넷에 연결되면 대기 중인 ${count(sync.pending)}건을 자동으로 맞춰요. 일정은 먼저 이 PC에 저장해요.` : '인터넷이 가능할 때 자동으로 변경 내용을 맞춰요. 연결이 끊겨도 이 PC에서 계속 사용할 수 있어요.';
    setText('account-detail', detail);
    setText('account-importLabel', sync.hasLocalAccountCopy
      ? '이 PC에 보관된 계정 자료로 돌아갑니다. 로그인 없이 작성한 자료는 따로 보관합니다.'
      : '이 PC의 기존 자료를 계정에 함께 저장합니다.');
    setText('account-connect', sync.hasLocalAccountCopy ? '계정 자료로 돌아가 자동 동기화 켜기' : '자료 연결하고 자동 동기화 켜기');
    const at = sync.lastSyncedAt ?? sync.lastSyncAt;
    const date = at ? new Date(at) : null;
    const validDate = date && Number.isFinite(date.getTime());
    setText('account-lastSync', validDate ? `마지막 동기화: ${date.toLocaleString('ko-KR')}` : '');
    visible('account-lastSync', !!validDate && !!sync.connected);
    visible('account-restoreNote', !!sync.connected);
    visible('account-recovery', recovering);
    $('account-resolveRecovery').disabled = busy || typeof api?.resolveRecovery !== 'function';
    visible('account-login', !!canLogin && !pendingLogin);
    visible('account-loginPending', !!pendingLogin);
    visible('account-codeForm', !!codeRequested && !!canLogin && !pendingLogin);
    setText('account-codeDestination', codeEmail ? `${codeEmail}로 보낸 인증번호를 입력해 주세요.` : '');
    visible('account-import', !!auth.authenticated && !sync.connected && !requiresLogin && !recovering);
    const actionUser = !!auth.authenticated || !!sync.connected || !!userId;
    visible('account-actions', actionUser);
    visible('account-syncNow', !!sync.connected);
    const conflicts = count(sync.conflictCount);
    visible('account-conflicts', conflicts > 0);
    setText('account-conflicts', conflicts ? `겹친 수정의 사본 ${conflicts}건이 보관되어 있어요. 최근 충돌 기록을 파일로 저장할 수 있어요.` : '');
    visible('account-exportConflicts', conflicts > 0 && typeof api?.exportConflicts === 'function');
    $('account-exportConflicts').disabled = busy || !auth.authenticated || requiresLogin;
    for (const id of ['account-google', 'account-email', 'account-emailSend', 'account-code', 'account-codeVerify']) $(id).disabled = !canAct || !canLogin;
    $('account-connect').disabled = !canAct || !auth.authenticated || !$('account-importConsent').checked;
    $('account-importConsent').disabled = busy;
    $('account-syncNow').disabled = !canAct || !sync.connected || !auth.authenticated || requiresLogin || sync.status === 'syncing';
    $('account-signOut').disabled = busy || recovering;
    $('account-signOutConfirm').disabled = busy || recovering;
    $('account-signOutCancel').disabled = busy;
    $('account-cancelSignIn').disabled = cancelBusy;
    let shown = feedback;
    if (auth.error) shown = { text: safeError(auth.error, '계정 연결을 완료하지 못했어요. 다시 시도해 주세요. 이 PC의 자료는 계속 사용할 수 있어요.'), tone: 'err' };
    else if (sync.error) shown = { text: safeError(sync.error, '동기화를 잠시 완료하지 못했어요. 연결이 복구되면 다시 시도해요. 이 PC의 자료는 계속 사용할 수 있어요.'), tone: '' };
    setText('account-message', shown?.text || '');
    $('account-message').className = 'set-msg account-message' + (shown?.tone ? ' ' + shown.tone : '');
    visible('account-message', !!shown);
    if (auth.authenticated && !requiresLogin) $('account-code').value = '';
  }
  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    current = { auth: next.auth && typeof next.auth === 'object' ? next.auth : {}, sync: next.sync && typeof next.sync === 'object' ? next.sync : {} };
    if (current.auth.pending === false) googlePending = false;
    stateSeq++;
    render();
  }
  async function refresh() {
    if (!available) return;
    const seq = stateSeq;
    const next = await api.getState();
    if (seq === stateSeq) applyState(next);
  }
  function lockProfile() {
    if (profileLock) return;
    const elements = [...document.querySelectorAll('.app, dialog')].map(element => ({ element, inert: element.inert }));
    const focus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'account-transition'; overlay.id = 'account-transition';
    overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite'); overlay.tabIndex = -1;
    const label = document.createElement('span'); label.textContent = '자료를 안전하게 전환하고 있어요. 잠시만 기다려 주세요.';
    overlay.append(label);
    const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const types = ['pointerdown', 'click', 'input', 'change', 'submit', 'keydown', 'keyup', 'keypress', 'paste', 'cut', 'drop', 'dragstart'];
    for (const { element } of elements) element.inert = true;
    for (const type of types) document.addEventListener(type, block, true);
    document.body.append(overlay); overlay.focus();
    profileLock = { elements, focus, overlay, block, types };
  }
  function unlockProfile() {
    if (!profileLock) return;
    const { elements, focus, overlay, block, types } = profileLock;
    profileLock = null;
    for (const type of types) document.removeEventListener(type, block, true);
    for (const { element, inert } of elements) element.inert = inert;
    overlay.remove();
    if (focus?.isConnected) focus.focus();
  }
  async function action(run, success, fallback, profileChange = false) {
    if (!available || busy) return;
    const seq = ++actionSeq;
    busy = true; feedback = null; render();
    if (profileChange) lockProfile();
    try {
      const result = await run();
      if (seq !== actionSeq) return;
      if (result?.error) throw result.error;
      if (typeof success === 'function') success(result);
      else if (success) feedback = { text: success, tone: 'ok' };
      await refresh();
    } catch (error) {
      if (seq === actionSeq) feedback = { text: safeError(error, fallback), tone: 'err' };
    } finally {
      if (profileChange) unlockProfile();
      if (seq === actionSeq) { busy = false; render(); }
    }
  }
  $('account-google').addEventListener('click', () => action(async () => {
    googlePending = true; render();
    try { return await api.signInGoogle(); }
    catch (error) { googlePending = false; throw error; }
  }, () => { feedback = null; }, 'Google 로그인을 완료하지 못했어요. 다시 시도하거나 이메일 로그인을 이용해 주세요.'));
  $('account-emailForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('account-emailForm').reportValidity()) return;
    const email = $('account-email').value.trim();
    action(() => api.sendEmailCode(email), () => {
      codeRequested = true; codeEmail = email; $('account-code').value = '';
      feedback = { text: '이메일로 인증번호를 보냈어요. 받은 번호를 입력해 주세요.', tone: 'ok' };
      setTimeout(() => { if (!current.auth.authenticated) $('account-code').focus(); }, 0);
    }, '인증번호를 보내지 못했어요. 이메일 주소를 확인하고 잠시 후 다시 시도해 주세요.');
  });
  $('account-email').addEventListener('input', () => {
    if ($('account-email').value.trim() !== codeEmail) { codeRequested = false; $('account-code').value = ''; feedback = null; render(); }
  });
  $('account-codeForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('account-codeForm').reportValidity() || !codeRequested) return;
    const code = $('account-code').value.trim();
    action(() => api.verifyEmailCode({ email: codeEmail, code }), '로그인했어요. 아래에서 기존 자료 연결을 선택해 주세요.', '로그인을 완료하지 못했어요. 인증번호를 확인하고 다시 시도해 주세요.');
  });
  $('account-importConsent').addEventListener('change', render);
  $('account-connect').addEventListener('click', () => {
    if (!$('account-importConsent').checked || !current.auth.authenticated) return;
    action(() => api.connect({ importLocal: true }), '자동 동기화를 켰어요. 앞으로 연결이 가능할 때 자동으로 맞춰요.', '자료 연결을 완료하지 못했어요. 이 PC의 자료는 보존돼 있어요. 다시 시도해 주세요.', true);
  });
  $('account-syncNow').addEventListener('click', () => action(() => api.syncNow(), null, '동기화를 완료하지 못했어요. 이 PC의 자료는 계속 사용할 수 있어요.'));
  $('account-exportConflicts').addEventListener('click', () => action(() => api.exportConflicts(), null, '충돌 기록을 저장하지 못했어요. 인터넷 연결과 저장 위치를 확인한 뒤 다시 시도해 주세요.'));
  $('account-resolveRecovery').addEventListener('click', () => action(() => api.resolveRecovery({ keepAsGuest: true }), '현재 자료를 이 PC에 보관했어요. 계정 연결은 다시 선택할 수 있어요.', '복구 자료 보관을 완료하지 못했어요. 이 PC의 저장 상태와 폴더 권한을 확인한 뒤 다시 시도해 주세요.', true));
  $('account-signOut').addEventListener('click', () => { visible('account-signOutPrompt', true); $('account-signOutCancel').focus(); });
  $('account-signOutCancel').addEventListener('click', () => { visible('account-signOutPrompt', false); $('account-signOut').focus(); });
  $('account-signOutConfirm').addEventListener('click', () => action(() => api.signOut(), () => {
    visible('account-signOutPrompt', false); $('account-importConsent').checked = false; codeRequested = false; codeEmail = '';
    $('account-email').value = ''; $('account-code').value = '';
    feedback = { text: '로그아웃했어요. 로그인 없이 계속 사용할 수 있어요.', tone: 'ok' };
  }, '로그아웃을 마치지 못했어요. 최근 변경이 저장됐는지 확인한 뒤 다시 시도해 주세요.', true));
  $('account-cancelSignIn').addEventListener('click', async () => {
    if (!available || cancelBusy) return;
    ++actionSeq; busy = false; cancelBusy = true; render();
    try { await api.cancelSignIn(); googlePending = false; feedback = null; await refresh(); }
    catch (error) { feedback = { text: safeError(error, '로그인 취소를 완료하지 못했어요. 잠시 후 다시 시도해 주세요.'), tone: 'err' }; }
    finally { cancelBusy = false; render(); }
  });
  render();
  if (available) {
    let unsubscribe;
    try { if (typeof api.onState === 'function') unsubscribe = api.onState(applyState); }
    catch { message('계정 상태를 확인하지 못했어요. 앱을 다시 실행해 주세요. 기존 자료는 계속 사용할 수 있어요.', 'err'); }
    refresh().catch(() => message('계정 상태를 확인하지 못했어요. 앱을 다시 실행해 주세요. 기존 자료는 계속 사용할 수 있어요.', 'err'));
    window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); }, { once: true });
  }
})();
