// 미리보기 전용 예시 데이터. (실제 앱에는 포함되지 않음)
// - 저장된 데이터가 없으면 예시 일정·할 일·목표를 한 번 넣습니다.
// - 예전 버전 데이터(카테고리/목표 없음)가 있으면 예시 카테고리와 목표만 덧붙입니다.
(function () {
  try {
    var R = window.Recurrence;
    var now = new Date();
    var day = function (n, h, m) {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, h || 0, m || 0);
    };
    var dt = function (d) { return R.fmtDateTime(d); };
    var dd = function (d) { return R.fmtDate(d); };
    var ev = function (o) {
      return Object.assign({ memo: '', allDay: false, repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null, categoryId: null }, o);
    };
    var td = function (o) {
      return Object.assign({ done: false, due: null, priority: 1, memo: '', categoryId: null, projectId: null }, o);
    };
    var cats = [
      { id: 'c-work', name: '업무', color: '#3b82f6' },
      { id: 'c-personal', name: '개인', color: '#22a06b' },
      { id: 'c-health', name: '운동', color: '#f59e0b' },
      { id: 'c-study', name: '공부', color: '#8b5cf6' },
      { id: 'c-meet', name: '약속', color: '#ec4899' },
    ];
    var projects = [
      { id: 'p1', title: '분기 보고서 마무리 (예시)', categoryId: 'c-work', due: dd(day(9)), status: 'active', memo: '', createdAt: 1 },
      { id: 'p2', title: '10km 달리기 완주 (예시)', categoryId: 'c-health', due: dd(day(45)), status: 'active', memo: '', createdAt: 2 },
      { id: 'p3', title: '토익 850점 (예시)', categoryId: 'c-study', due: dd(day(80)), status: 'active', memo: '', createdAt: 3 },
    ];
    var projTodos = [
      td({ id: 'pt1', title: '자료 수집', done: true, projectId: 'p1', due: dd(day(-2)), createdAt: 11 }),
      td({ id: 'pt2', title: '초안 작성', projectId: 'p1', due: dd(day(3)), priority: 2, createdAt: 12 }),
      td({ id: 'pt3', title: '팀 검토 받기', projectId: 'p1', due: dd(day(6)), createdAt: 13 }),
      td({ id: 'pt4', title: '3km 달리기', done: true, projectId: 'p2', createdAt: 14 }),
      td({ id: 'pt5', title: '5km 달리기', projectId: 'p2', due: dd(day(10)), createdAt: 15 }),
      td({ id: 'pt6', title: '7km 달리기', projectId: 'p2', due: dd(day(24)), createdAt: 16 }),
    ];

    var raw = localStorage.getItem('planner-data');
    var data = raw ? JSON.parse(raw) : null;

    if (!data) {
      data = {
        events: [
          ev({ id: 's1', title: '팀 회의 (예시)', categoryId: 'c-work', start: dt(day(0, 10)), end: dt(day(0, 11)), repeat: 'weekly', reminder: 10 }),
          ev({ id: 's2', title: '점심 약속 (예시)', categoryId: 'c-meet', start: dt(day(1, 12, 30)), end: dt(day(1, 13, 30)) }),
          ev({ id: 's3', title: '운동 (예시)', categoryId: 'c-health', start: dt(day(0, 19)), end: dt(day(0, 20)), repeat: 'daily', repeatUntil: dd(day(6)) }),
          ev({ id: 's4', title: '출장 (예시)', categoryId: 'c-work', allDay: true, start: dd(day(3)), end: dd(day(4)) }),
          ev({ id: 's5', title: '보고서 마감 (예시)', categoryId: 'c-work', start: dt(day(5, 15)), end: dt(day(5, 16)), reminder: 60 }),
          ev({ id: 's6', title: '치과 (예시)', categoryId: 'c-personal', start: dt(day(1, 10, 30)), end: dt(day(1, 11, 30)) }),
          ev({ id: 's7', title: '영어 스터디 (예시)', categoryId: 'c-study', start: dt(day(2, 20)), end: dt(day(2, 21, 30)), repeat: 'weekly' }),
        ],
        todos: [
          td({ id: 't2', title: '장보기 (예시)', due: dd(day(0)), categoryId: 'c-personal', createdAt: 2 }),
          td({ id: 't3', title: '치과 예약 전화 (예시)', due: dd(day(-1)), categoryId: 'c-personal', createdAt: 3 }),
          td({ id: 't4', title: '운동화 주문 (예시)', done: true, priority: 0, categoryId: 'c-health', createdAt: 4 }),
        ].concat(projTodos),
        projects: projects,
        categories: cats,
        settings: { defaultView: 'month', weekStart: 0 },
      };
      localStorage.setItem('planner-data', JSON.stringify(data));
    } else if (!data.categories && !data.projects) {
      // 예전 데이터 이전: 샘플 일정/할 일에 카테고리를 붙이고, 예시 목표를 추가
      var map = { s1: 'c-work', s2: 'c-meet', s3: 'c-health', s4: 'c-work', s5: 'c-work', s6: 'c-personal', t1: 'c-work', t2: 'c-personal', t3: 'c-personal', t4: 'c-health' };
      (data.events || []).forEach(function (e) { if (map[e.id] && !e.categoryId) e.categoryId = map[e.id]; });
      (data.todos || []).forEach(function (t) { if (map[t.id] && !t.categoryId) t.categoryId = map[t.id]; });
      data.categories = cats;
      data.projects = projects;
      data.todos = (data.todos || []).concat(projTodos);
      localStorage.setItem('planner-data', JSON.stringify(data));
    }
  } catch (e) { /* 저장소를 못 쓰는 환경이면 빈 상태로 시작 */ }
})();
