'use strict';

// Electron 연결은 main.js가 담당합니다. 이 모듈은 업데이트 상태와 설치 순서를 관리합니다.
function createUpdateController({ updater, currentVersion, disabledReason, prepareInstall, performInstall, installFailed, notify = () => {} }) {
  const enabled = !!updater;
  let disposed = false;
  let checkPromise = null;
  let installPromise = null;
  let state = { revision: 0, currentVersion, status: enabled ? 'idle' : 'unsupported', disabledReason: disabledReason || '', version: '', percent: 0, issue: '' };
  const listeners = [];
  const snapshot = () => ({ ...state });
  function publish(next) {
    if (disposed) return;
    state = { ...state, ...next, revision: state.revision + 1 };
    notify(snapshot());
  }
  function fail() {
    if (disposed) return;
    if (state.status === 'installing') {
      installFailed();
      publish({ status: 'restart-required', issue: 'install' });
    } else publish({ status: 'error', issue: 'network', percent: 0 });
  }
  function on(event, fn) { updater.on(event, fn); listeners.push([event, fn]); }
  if (enabled) {
    updater.autoDownload = true;
    // 일반 종료나 Windows 종료를 설치 계기로 사용하지 않습니다.
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    on('checking-for-update', () => publish({ status: 'checking', issue: '' }));
    on('update-not-available', () => publish({ status: 'up-to-date', version: '', percent: 0, issue: '' }));
    on('update-available', info => publish({ status: 'downloading', version: info.version, percent: 0, issue: '' }));
    on('download-progress', progress => publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) }));
    on('update-downloaded', info => publish({ status: 'ready', version: info.version, percent: 100, issue: '' }));
    on('error', fail);
  }
  async function check() {
    if (disposed || !enabled || checkPromise || ['checking', 'downloading', 'ready', 'preparing', 'installing', 'restart-required'].includes(state.status)) return snapshot();
    publish({ status: 'checking', issue: '' });
    checkPromise = (async () => {
      try {
        const result = await updater.checkForUpdates();
        // 자동 다운로드의 실패도 처리해 미처리 Promise가 남지 않게 합니다.
        if (result?.downloadPromise) result.downloadPromise.catch(fail);
        if (!result && state.status === 'checking') fail();
      } catch { fail(); }
    })();
    await checkPromise;
    checkPromise = null;
    return snapshot();
  }
  async function install() {
    if (disposed || !enabled || installPromise || state.status !== 'ready') return snapshot();
    publish({ status: 'preparing', issue: '' });
    installPromise = (async () => {
      let issue;
      try { issue = await prepareInstall(); } catch { issue = 'save'; }
      if (disposed) return;
      if (issue !== '') { publish({ status: 'ready', issue: ['save', 'backup', 'busy'].includes(issue) ? issue : 'save' }); return; }
      // 준비 중 상태가 바뀌면 설치를 진행하지 않습니다.
      if (state.status !== 'preparing') return;
      publish({ status: 'installing', issue: '' });
      try { performInstall(); } catch { fail(); }
    })();
    await installPromise;
    installPromise = null;
    return snapshot();
  }
  let firstTimer;
  let repeatTimer;
  return {
    getState: snapshot, check, install,
    start() {
      if (!enabled || disposed || firstTimer) return;
      firstTimer = setTimeout(() => { void check(); }, 10000);
      repeatTimer = setInterval(() => { void check(); }, 6 * 60 * 60 * 1000);
      firstTimer.unref?.(); repeatTimer.unref?.();
    },
    dispose() {
      disposed = true;
      clearTimeout(firstTimer); clearInterval(repeatTimer);
      // 종료 중 늦게 온 오류도 처리합니다. 나머지 이벤트는 정리합니다.
      for (const [event, listener] of listeners) if (event !== 'error') updater.removeListener(event, listener);
    }
  };
}

module.exports = { createUpdateController };
