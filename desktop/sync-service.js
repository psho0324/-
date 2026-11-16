// Native, optional account synchronization. Local planner writes never wait for
// a server. The private sidecar contains data/journal only, never auth tokens.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Sync = require('./renderer/sync-core.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = () => ({ events: [], todos: [], projects: [], categories: [], goalRecords: [], goalDays: [], settings: {} });
const isData = value => object(value) && Sync.KINDS.every(kind => value[kind] === undefined || Array.isArray(value[kind])) &&
  (value.settings === undefined || object(value.settings));
const error = (code, message) => Object.assign(new Error(message), { code });
function validBackend(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && url.origin === value && url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function createSyncService(options) {
  const { userDataDir, account, loadData, saveData, onData = () => {}, onState = () => {}, beforeApply = async () => true,
    now = () => Date.now(), timers = { setTimeout, clearTimeout }, pollMs = 60000 } = options;
  if (!userDataDir || !account || typeof account.getState !== 'function' || typeof account.rpc !== 'function' ||
      typeof loadData !== 'function' || typeof saveData !== 'function') throw new TypeError('Native sync dependencies are required');
  const file = path.join(userDataDir, 'planner-sync-state.json');
  let envelope = { schemaVersion: 1, deviceId: randomUUID(), backendId: null, activeAccountId: null, guestData: null, profiles: {}, transition: null, recovery: null };
  let corrupt = false, journalError = null, operationError = null, running = null, timer = null, unsubscribe = null;
  let started = false, disposed = false, switching = false, generation = 0, failures = 0;
  let switchQueue = Promise.resolve();

  function validate(value) {
    if (!object(value) || value.schemaVersion !== 1 || !UUID.test(value.deviceId) || !object(value.profiles) ||
        (value.backendId !== null && !validBackend(value.backendId)) || (Object.keys(value.profiles).length && !value.backendId) ||
        (value.activeAccountId !== null && !UUID.test(value.activeAccountId)) ||
        (value.guestData !== null && !isData(value.guestData))) throw Error('Invalid native sync state');
    const checked = clone(value);
    for (const [id, profile] of Object.entries(checked.profiles)) {
      if (!UUID.test(id) || !object(profile) || !isData(profile.data) ||
          (profile.email !== undefined && typeof profile.email !== 'string') ||
          (profile.hasMore !== undefined && typeof profile.hasMore !== 'boolean') ||
          (profile.remoteConflictCount !== undefined && (!Number.isSafeInteger(profile.remoteConflictCount) || profile.remoteConflictCount < 0)) ||
          (profile.lastSyncAt !== null && (typeof profile.lastSyncAt !== 'string' || !Number.isFinite(Date.parse(profile.lastSyncAt)))))
        throw Error('Invalid native account profile');
      profile.engine = Sync.validateState(profile.engine, { accountId: id, deviceId: checked.deviceId });
    }
    if (checked.activeAccountId && !checked.profiles[checked.activeAccountId]) throw Error('Missing active native profile');
    if (checked.transition !== null && (!object(checked.transition) || !isData(checked.transition.data) || !isData(checked.transition.sourceData) ||
        checked.transition.sourceAccountId !== checked.activeAccountId ||
        (checked.transition.accountId !== null && (!UUID.test(checked.transition.accountId) || !checked.profiles[checked.transition.accountId]))))
      throw Error('Invalid native profile transition');
    if (checked.recovery !== null && (!object(checked.recovery) || !UUID.test(checked.recovery.id || '') || !isData(checked.recovery.data) ||
        !isData(checked.recovery.sourceData) || !isData(checked.recovery.targetData) ||
        [checked.recovery.sourceAccountId, checked.recovery.targetAccountId].some(id => id !== null && (!UUID.test(id) || !checked.profiles[id]))))
      throw Error('Invalid native profile recovery');
    return checked;
  }
  try { envelope = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) {
    if (e.code !== 'ENOENT') { corrupt = true; journalError = error('PLANNER_SYNC_STORAGE', '동기화 기록을 읽지 못했어요. 기기의 자료는 계속 사용할 수 있어요.'); }
  }
  function accountState() {
    try { const state = account.getState(); return object(state) ? state : {}; } catch { return {}; }
  }
  const active = () => envelope.activeAccountId ? envelope.profiles[envelope.activeAccountId] : null;
  const changedBackend = auth => !!envelope.backendId && auth.configured === true && auth.backendId !== envelope.backendId;
  function getState() {
    const auth = accountState(), profile = active();
    const authenticated = auth.authenticated === true && UUID.test(auth.user?.id || '');
    const connected = !!profile && !envelope.recovery;
    const pending = connected ? Sync.pendingCount(profile.engine) : 0;
    const sameAccount = authenticated && auth.needsLogin !== true && auth.user.id === envelope.activeAccountId;
    let status = 'guest';
    if (envelope.recovery) status = 'recovery-required';
    else if (corrupt || journalError || envelope.transition) status = 'error';
    else if (switching || running) status = 'syncing';
    else if (auth.configured !== true) status = 'unconfigured';
    else if (changedBackend(auth)) status = 'backend-mismatch';
    else if (connected && authenticated && auth.user.id !== envelope.activeAccountId) status = 'account-mismatch';
    else if (connected && !sameAccount) status = 'login-required';
    else if (connected && operationError) status = 'retry';
    else if (connected) status = !pending && !profile.hasMore && profile.lastSyncAt ? 'synced' : 'waiting';
    const problem = journalError || operationError || (envelope.recovery ?
      error('PLANNER_SYNC_RECOVERY', '중단된 계정 전환의 자료를 기기에 보존했어요. 어느 계정에도 자동으로 올리지 않아요.') : null) ||
      (changedBackend(auth) ? error('PLANNER_SYNC_BACKEND_CHANGED', '계정 서버 설정이 바뀌어 자동 동기화를 멈췄어요. 기기 자료는 그대로 보관돼요.') : null);
    return {
      configured: auth.configured === true, connected, authenticated, recoveryRequired: !!envelope.recovery, backendChanged: changedBackend(auth),
      hasLocalAccountCopy: authenticated && !changedBackend(auth) && !!envelope.profiles[auth.user.id],
      needsLogin: connected && !sameAccount,
      status, user: connected ? { id: envelope.activeAccountId, email: profile.email || '' } :
        (authenticated ? { id: auth.user.id, email: typeof auth.user.email === 'string' ? auth.user.email : '' } : null),
      pending, catchingUp: connected && profile.hasMore === true,
      conflictCount: profile ? Math.max(profile.engine.conflictIds.length, profile.remoteConflictCount || 0) : 0,
      lastSyncAt: profile?.lastSyncAt || null,
      error: problem ? { code: problem.code || 'PLANNER_SYNC_RETRY', message: problem.message } : null,
    };
  }
  function emit() { try { onState(getState()); } catch { /* UI failures cannot block local writes. */ } }
  function persist() {
    if (corrupt) throw journalError;
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      journalError = null;
    } catch {
      journalError = error('PLANNER_SYNC_STORAGE', '동기화 대기 기록을 저장하지 못했어요. 기기 저장은 유지되며 연결 전 다시 시도해요.');
      throw journalError;
    }
  }
  function readLocal() {
    const data = loadData();
    if (!isData(data) || typeof data?.then === 'function') throw error('PLANNER_SYNC_DATA', '기기 자료를 안전하게 읽지 못했어요.');
    return clone(data);
  }
  function writeLocal(data, reason, baseData) {
    // Native saveData MUST be synchronous. No main-process event can interleave
    // between merging the current journal and this atomic store write.
    const result = saveData(clone(data));
    if (result && typeof result.then === 'function') throw TypeError('saveData must be synchronous');
    if (result === false) throw error('PLANNER_SYNC_DATA', '기기 자료 저장을 확인하지 못했어요.');
    try { onData(clone(data), { reason, baseData: clone(baseData) }); } catch { /* Durable data remains available on reload. */ }
  }
  function capture(data) {
    const profile = active();
    if (profile) { profile.engine = Sync.stage(profile.engine, data); profile.data = clone(data); }
    else if (envelope.guestData !== null || envelope.transition) envelope.guestData = clone(data);
  }
  function allowed() {
    const auth = accountState();
    return !disposed && !corrupt && !switching && !envelope.transition && !envelope.recovery && !!active() &&
      auth.configured === true && validBackend(auth.backendId) && envelope.backendId === auth.backendId &&
      auth.authenticated === true && auth.needsLogin !== true && auth.user?.id === envelope.activeAccountId;
  }
  function clearTimer() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function schedule(delay = pollMs) {
    clearTimer();
    if (!started || disposed || corrupt || !active()) return;
    timer = timers.setTimeout(() => { timer = null; void syncNow(); }, delay);
    timer?.unref?.();
  }
  function localSaved(data) {
    if (disposed || corrupt) return getState();
    if (envelope.recovery) {
      try { envelope.recovery.data = clone(data); persist(); } catch { /* Native planner data remains authoritative. */ }
      emit(); return getState();
    }
    if (!active()) return getState();
    try { capture(clone(data)); persist(); operationError = null; }
    catch (e) { if (!journalError) operationError = error('PLANNER_SYNC_DATA', '변경을 동기화 대기 목록에 넣지 못했어요. 기기 자료는 유지돼요.'); }
    emit();
    if (allowed() && !running) schedule(300);
    return getState();
  }
  function finishTransition() {
    const transition = envelope.transition;
    if (!transition) return;
    const current = readLocal();
    // Two separate files cannot prove ownership after a crash plus later edits.
    // Preserve an ambiguous snapshot without guessing its account or replacing
    // it with a stale target. Only exact source/target snapshots resume silently.
    if (!equal(current, transition.data) && !equal(current, transition.sourceData)) {
      envelope.recovery = { id: randomUUID(), data: clone(current), sourceData: clone(transition.sourceData), targetData: clone(transition.data),
        sourceAccountId: transition.sourceAccountId, targetAccountId: transition.accountId };
      envelope.transition = null;
      persist();
      throw error('PLANNER_SYNC_RECOVERY', '계정 전환 중 바뀐 자료를 기기에 보존했어요. 복구 자료를 확인해 주세요.');
    }
    if (!equal(current, transition.data)) writeLocal(transition.data, 'profile', current);
    envelope.activeAccountId = transition.accountId;
    envelope.transition = null;
    persist();
  }
  function start() {
    if (started || disposed) return getState();
    started = true;
    if (!corrupt) {
      try {
        if (envelope.transition) finishTransition();
        if (envelope.recovery) { envelope.recovery.data = readLocal(); persist(); }
        else if (active()) { capture(readLocal()); persist(); }
      } catch (e) { if (!journalError) operationError = e.code === 'PLANNER_SYNC_RECOVERY' ? e :
        error('PLANNER_SYNC_DATA', '기기 자료를 동기화 준비 중이에요. 저장 상태를 확인해 주세요.'); }
    }
    if (typeof account.onState === 'function') unsubscribe = account.onState(() => {
      emit(); if (allowed()) schedule(0); else clearTimer();
    });
    emit();
    if (allowed()) schedule(0);
    return getState();
  }
  async function syncRound(ticket) {
    let pages = 0;
    while (allowed() && ticket === generation && pages++ < 20) {
      const id = envelope.activeAccountId;
      capture(readLocal());
      const prepared = Sync.prepare(active().engine);
      active().engine = prepared.state;
      persist(); // Stable operation IDs MUST reach disk before any request.
      const request = prepared.request;
      const response = await account.rpc('planner_sync', {
        p_device_id: request.deviceId, p_cursor: request.cursor, p_ops: request.ops, p_limit: request.limit,
      }, { accountId: id });
      if (!allowed() || ticket !== generation || envelope.activeAccountId !== id) return;
      if (response?.conflictCount !== undefined && (!Number.isSafeInteger(response.conflictCount) || response.conflictCount < 0))
        throw error('PLANNER_SYNC_RESPONSE', '서버의 충돌 기록 수를 확인하지 못했어요.');
      if (await beforeApply({ reason: 'sync', accountId: id }) !== true) throw error('PLANNER_SYNC_LOCAL_SAVE', '최근 변경을 기기에 저장한 뒤 자동 동기화를 다시 시도해요.');
      if (!allowed() || ticket !== generation || envelope.activeAccountId !== id) return;
      const baseData = readLocal();
      capture(baseData); // Includes edits saved while the network/flush awaited.
      const accepted = Sync.accept(active().engine, response);
      const next = Sync.materialize(accepted, baseData);
      if (!equal(next, baseData)) writeLocal(next, 'sync', baseData);
      active().engine = accepted;
      active().data = clone(next);
      active().lastSyncAt = new Date(now()).toISOString();
      active().hasMore = response.hasMore;
      if (response.conflictCount !== undefined) active().remoteConflictCount = Math.max(active().remoteConflictCount || 0, response.conflictCount);
      persist();
      operationError = null;
      failures = 0;
      emit();
      if (!response.hasMore && !Sync.pendingCount(active().engine)) break;
    }
  }
  function syncNow() {
    if (running) return running;
    clearTimer();
    if (!allowed()) { emit(); return Promise.resolve(getState()); }
    const ticket = generation;
    running = Promise.resolve().then(() => syncRound(ticket)).catch(e => {
      if (ticket === generation && !disposed) {
        failures++;
        operationError = error(e.code === 'PLANNER_SYNC_LOCAL_SAVE' ? e.code : 'PLANNER_SYNC_RETRY',
          e.code === 'PLANNER_SYNC_LOCAL_SAVE' ? e.message : '연결을 기다리는 중이에요. 기기에 저장한 내용은 자동으로 다시 동기화해요.');
        // Fixed text keeps server payloads, token-bearing URLs and OS paths out
        // of renderer status/error reporting.
      }
    }).finally(() => {
      running = null;
      emit();
      if (allowed()) schedule(failures ? Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) :
        (Sync.pendingCount(active().engine) || active().hasMore ? 1000 : pollMs));
    }).then(() => getState());
    emit();
    return running;
  }
  function enqueueSwitch(fn) {
    const task = switchQueue.catch(() => {}).then(fn);
    switchQueue = task.catch(() => {});
    return task;
  }
  function connect({ importLocal = false } = {}) {
    return enqueueSwitch(async () => {
      const auth = accountState();
      if (disposed || corrupt) throw journalError || error('PLANNER_SYNC_CLOSED', '동기화를 시작할 수 없어요.');
      if (envelope.recovery) throw error('PLANNER_SYNC_RECOVERY', '보존된 복구 자료를 먼저 확인해 주세요.');
      if (changedBackend(auth)) throw error('PLANNER_SYNC_BACKEND_CHANGED', '계정 서버 설정이 바뀌었어요. 이전 기기 자료를 다른 서버로 자동 이전하지 않아요.');
      if (!auth.configured || !validBackend(auth.backendId) || !auth.authenticated || auth.needsLogin === true || !UUID.test(auth.user?.id || ''))
        throw error('PLANNER_AUTH_REQUIRED', '계정을 연결한 뒤 사용할 수 있어요.');
      const id = auth.user.id;
      if (envelope.activeAccountId && envelope.activeAccountId !== id) throw error('PLANNER_ACCOUNT_SWITCH_REQUIRED', '현재 계정 연결을 먼저 해제해 주세요. 다른 계정의 자료는 함께 올리지 않아요.');
      switching = true; const ticket = ++generation; clearTimer(); emit();
      try {
        if (await beforeApply({ reason: 'profile', accountId: id }) !== true) throw error('PLANNER_SYNC_LOCAL_SAVE', '최근 변경을 기기에 저장한 뒤 계정을 연결해 주세요.');
        if (disposed || ticket !== generation) throw error('PLANNER_SYNC_CLOSED', '계정 연결이 취소됐어요.');
        if (accountState().user?.id !== id || accountState().backendId !== auth.backendId) throw error('PLANNER_AUTH_CHANGED', '계정이 변경됐어요. 다시 연결해 주세요.');
        if (envelope.transition) finishTransition();
        const current = readLocal();
        if (envelope.activeAccountId === id) { capture(current); persist(); return getState(); }
        envelope.backendId = auth.backendId;
        envelope.guestData = clone(current);
        let profile = envelope.profiles[id];
        if (!profile) {
          const initial = importLocal ? current : { ...empty(), settings: clone(current.settings || {}) };
          profile = { engine: Sync.createState({ accountId: id, deviceId: envelope.deviceId, data: initial }), data: clone(initial),
            email: typeof auth.user.email === 'string' ? auth.user.email : '', lastSyncAt: null, hasMore: false, remoteConflictCount: 0 };
          envelope.profiles[id] = profile;
        }
        const target = Sync.materialize(profile.engine, { ...profile.data, settings: clone(current.settings || {}) });
        envelope.transition = { accountId: id, data: target, sourceAccountId: envelope.activeAccountId, sourceData: clone(current) };
        persist();
        finishTransition();
        operationError = null; failures = 0;
      } finally { switching = false; emit(); if (allowed()) schedule(0); }
      return getState();
    });
  }
  function disconnect() {
    return enqueueSwitch(async () => {
      if (disposed || corrupt) throw journalError || error('PLANNER_SYNC_CLOSED', '연결을 해제할 수 없어요.');
      if (envelope.recovery) throw error('PLANNER_SYNC_RECOVERY', '보존된 복구 자료를 먼저 확인해 주세요.');
      if (!active() && !envelope.transition) return getState();
      switching = true; const ticket = ++generation; clearTimer(); emit();
      try {
        if (await beforeApply({ reason: 'profile', accountId: null }) !== true) throw error('PLANNER_SYNC_LOCAL_SAVE', '최근 변경을 기기에 저장한 뒤 연결을 해제해 주세요.');
        if (disposed || ticket !== generation) throw error('PLANNER_SYNC_CLOSED', '계정 연결 해제가 취소됐어요.');
        if (envelope.transition) finishTransition();
        const current = readLocal();
        capture(current);
        const target = { ...(envelope.guestData || empty()), settings: clone(current.settings || {}) };
        envelope.transition = { accountId: null, data: clone(target), sourceAccountId: envelope.activeAccountId, sourceData: clone(current) };
        persist();
        finishTransition();
        operationError = null;
      } finally { switching = false; emit(); }
      return getState();
    });
  }
  function resolveRecovery({ keepAsGuest = false } = {}) {
    return enqueueSwitch(async () => {
      if (disposed || corrupt) throw journalError || error('PLANNER_SYNC_CLOSED', '복구를 진행할 수 없어요.');
      if (!envelope.recovery) return getState();
      if (keepAsGuest !== true) throw error('PLANNER_SYNC_RECOVERY_CHOICE', '현재 복구 자료를 이 기기에 보관할지 확인해 주세요.');
      switching = true; const ticket = ++generation; clearTimer(); emit();
      try {
        if (await beforeApply({ reason: 'profile', accountId: null }) !== true) throw error('PLANNER_SYNC_LOCAL_SAVE', '최근 변경을 기기에 저장한 뒤 복구해 주세요.');
        if (disposed || ticket !== generation) throw error('PLANNER_SYNC_CLOSED', '복구가 취소됐어요.');
        const previous = clone(envelope), current = readLocal();
        // Keep all three snapshots even after the user chooses device-only
        // recovery. The original guest/account snapshots must remain recoverable.
        const archive = path.join(userDataDir, 'planner-sync-recovery-' + envelope.recovery.id + '.json');
        try {
          fs.writeFileSync(archive + '.tmp', JSON.stringify({ ...envelope.recovery, data: current, resolvedAt: new Date(now()).toISOString() }), { encoding: 'utf8', mode: 0o600 });
          fs.renameSync(archive + '.tmp', archive);
        } catch { throw error('PLANNER_SYNC_STORAGE', '복구 사본을 보관하지 못했어요. 기기 자료와 기존 복구 기록은 유지돼요.'); }
        envelope.guestData = clone(current);
        envelope.activeAccountId = null;
        envelope.recovery = null;
        envelope.transition = null;
        try { persist(); } catch (e) { envelope = previous; throw e; }
        operationError = null; failures = 0;
        // The current native file stays untouched, so no ambiguous account data
        // can be uploaded or replaced as a side effect of recovery.
      } finally { switching = false; emit(); }
      return getState();
    });
  }
  function dispose() {
    disposed = true; generation++; clearTimer();
    if (typeof unsubscribe === 'function') unsubscribe();
  }
  return { start, localSaved, syncNow, connect, disconnect, resolveRecovery, getState, dispose };
}

module.exports = { createSyncService };
