// 저장소 어댑터.
// Electron 안에서는 preload가 노출한 window.storage(JSON 파일)를 쓰고,
// 브라우저에서 index.html을 그냥 열어 테스트할 때는 localStorage로 대체합니다.
// 서버/DB로 옮길 때는 이 파일(과 main.js의 load/save)만 바꾸면 됩니다.
window.PlannerStorage = {
  async load() {
    if (window.storage) return (await window.storage.load()) || {};
    try {
      return JSON.parse(localStorage.getItem('planner-data')) || {};
    } catch {
      return {};
    }
  },
  async save(data) {
    if (window.storage) return window.storage.save(data);
    localStorage.setItem('planner-data', JSON.stringify(data));
    return true;
  },
};

// 설치한 앱(Electron)에서만 있는 기능: 저장 위치, 자동 백업, 다른 PC 변경 감지.
// 브라우저 미리보기에서는 null 이므로 화면이 알아서 숨기거나 비활성화합니다.
window.PlannerNative = window.storage && window.storage.info ? window.storage : null;
