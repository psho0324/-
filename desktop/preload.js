const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storage', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),

  // 저장 위치 (동기화 폴더)
  info: () => ipcRenderer.invoke('storage:info'),
  openFolder: () => ipcRenderer.invoke('storage:openFolder'),
  chooseFolder: () => ipcRenderer.invoke('storage:chooseFolder'),
  resetFolder: () => ipcRenderer.invoke('storage:resetFolder'),

  // 자동 백업
  listBackups: () => ipcRenderer.invoke('backups:list'),
  backupNow: () => ipcRenderer.invoke('backups:now'),
  restoreBackup: (name) => ipcRenderer.invoke('backups:restore', name),
  openBackupFolder: () => ipcRenderer.invoke('backups:openFolder'),

  // 다른 PC에서 데이터가 바뀌었을 때 호출됨
  onExternalChange: (cb) => ipcRenderer.on('data:external', (_e, d) => cb(d)),

  // 종료·창 닫기 직전에 main이 "저장 끝났어?"라고 물으면, cb()가 끝날 때까지 기다렸다가 true/false(저장 성공 여부)로 답해요.
  onFlushRequest: (cb) => ipcRenderer.on('app:flush-request', async (_e, id) => {
    let ok = false;
    try { ok = (await cb()) === true; } catch { ok = false; }
    ipcRenderer.send('app:flush-done', id, ok);
  }),
});
