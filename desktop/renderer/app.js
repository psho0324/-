(() => {
  'use strict';

  const { fmtDate, fmtDateTime, parseLocal, occurrencesInRange } = window.Recurrence;
  const $ = (sel, root = document) => root.querySelector(sel);

  const COLORS = ['#3b82f6', '#ef4444', '#22a06b', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const HOUR_H = 48; // styles.css의 .tg-col 줄 간격과 맞춰야 함
  const DAY_MS = 864e5;
  const NONE = 'none'; // 필터에서 "미분류"를 가리키는 키
  const UNCAT_COLOR = '#64748b';

  const DEFAULT_CATS = () => [
    { id: 'c-work', name: '업무', color: '#3b82f6' },
    { id: 'c-personal', name: '개인', color: '#22a06b' },
    { id: 'c-health', name: '운동', color: '#f59e0b' },
    { id: 'c-study', name: '공부', color: '#8b5cf6' },
    { id: 'c-meet', name: '약속', color: '#ec4899' },
  ];

  // ---------- 상태 ----------
  let data = { events: [], todos: [], projects: [], categories: [], settings: {} };
  const state = {
    view: 'month',
    cursor: new Date(),
    page: 'home', // 'home' | 'calendar' | 'todos' | 'goals' | 'settings'
    selDay: null, // 좁은 화면 월간 달력에서 고른 날(YYYY-MM-DD)
    miniCursor: new Date(), // 홈의 작은 달력이 보여 주는 달
    lateExpanded: false, // 홈의 밀린 할 일을 모두 펼칠지
    lastDropped: 0, // 마지막으로 불러올 때 형식이 깨져서 제외한 항목 수
    undoSnap: null, // 삭제 직전 데이터(실행 취소용)
    undoImport: null, // 가져오기 직전 데이터(되돌리기용)
    quickKind: 'auto', // 빠른 추가 종류 선택: 'auto' | 'event' | 'todo'
    statRange: 'week', // 통계 기간: 'week' | 'month' | 'd30'
    todoFilter: 'all',
    projFilter: 'active',
    scrollTop: 7 * HOUR_H,
    hidden: new Set(), // 숨긴 카테고리 키(카테고리 id 또는 NONE)
    q: '',
    expanded: new Set(), // 할 일을 모두 펼친 목표 id
  };

  // ---------- 유틸 ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const uid = () =>
    (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 한국 공휴일(설정에서 끌 수 있어요). 없으면 null.
  const holiday = (day) => (data.settings.holidays !== false && window.Holidays ? window.Holidays.info(fmtDate(day)) : null);
  const weekStart = () => Number(data.settings.weekStart) === 1 ? 1 : 0;
  const shortDate = (s) => { const [, m, d] = s.split('-'); return `${+m}/${+d}`; };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((x) => x != null && x !== false));
    return el;
  }

  // 화면 아래에 잠깐 뜨는 안내. action을 주면 "실행 취소" 같은 버튼이 붙어요.
  let toastTimer = null;
  function toast(message, action, ms = 6000) {
    const el = $('#toast');
    clearTimeout(toastTimer);
    el.replaceChildren(h('span', { text: message }));
    if (action) {
      el.append(h('button', { type: 'button', class: 'toast-btn', onclick: () => { hideToast(); action.run(); } }, action.label));
    }
    el.hidden = false;
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
  }

  // ---------- 삭제 실행 취소 ----------
  const takeSnapshot = () => JSON.parse(JSON.stringify(data));
  function clearUndo() {
    if (!state.undoSnap) return;
    state.undoSnap = null;
    hideToast();
  }
  // 삭제를 실행하고 save()까지 한 뒤에 부릅니다: 삭제 전 스냅샷으로 "실행 취소"를 보여 줘요.
  function offerUndo(msg, snap) {
    state.undoSnap = snap;
    toast(msg, { label: '실행 취소', run: undoDelete }, 7000);
  }
  function undoDelete() {
    if (!state.undoSnap) return;
    const snap = state.undoSnap;
    state.undoSnap = null; // save()가 만료 처리하지 않도록 먼저 비움
    hideToast();
    applyLoaded(snap);
    save();
    render();
  }

  // ---------- 저장 (상태 표시 + 실패 시 재시도) ----------
  // 화면에서 바꾼 내용은 잠깐 모았다가(100ms) 저장해요. 저장이 실패하면 오른쪽 아래에
  // "저장 실패 · 다시 시도"가 계속 떠 있고, 5초마다 자동으로도 다시 시도해요.
  let saveTimer = null;
  let retryTimer = null;
  let savedTimer = null;
  let dirty = false;    // 진행 중에 또 바뀌어서 한 번 더 저장해야 하는지
  let saveFailed = false;

  function setSaveStatus(kind, detail) {
    const el = $('#saveStatus');
    if (!el) return;
    clearTimeout(savedTimer);
    el.dataset.state = kind;
    if (kind === 'idle') { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    if (kind === 'saving') {
      el.setAttribute('role', 'status');
      el.replaceChildren(h('span', { text: '저장 중…' }));
    } else if (kind === 'saved') {
      el.setAttribute('role', 'status');
      el.replaceChildren(h('span', { text: '✓ 저장됨' }));
      savedTimer = setTimeout(() => setSaveStatus('idle'), 1800);
    } else if (kind === 'error') {
      el.setAttribute('role', 'alert');
      el.replaceChildren(
        h('span', { class: 'save-msg', text: '⚠ 저장 실패 — 이 내용은 아직 저장되지 않았어요' }),
        h('button', { type: 'button', class: 'save-retry', onclick: () => retrySave() }, '다시 시도'),
      );
      if (detail) el.title = String(detail);
    }
  }

  // 저장을 한 줄로 세워요: 저장하는 도중에 또 바뀌면, 끝난 뒤 가장 최신 내용으로 한 번 더 저장해요.
  // 반환값은 "모두 저장됐는지"(true/false)예요.
  let inflight = null;
  function writeNow() {
    dirty = true;
    clearTimeout(retryTimer);
    if (inflight) return inflight;
    inflight = (async () => {
      // 저장이 0.4초 넘게 걸릴 때만 "저장 중"을 보여 줘서 화면이 깜빡이지 않게 해요.
      const slow = setTimeout(() => { if (inflight && !saveFailed) setSaveStatus('saving'); }, 400);
      let ok = true;
      let err = null;
      try {
        while (dirty) {
          dirty = false;
          await window.PlannerStorage.save(JSON.parse(JSON.stringify(data)));
        }
      } catch (e) {
        ok = false;
        err = e;
        console.error('저장 실패', e);
      }
      clearTimeout(slow);
      inflight = null;
      if (ok) {
        const wasFailed = saveFailed;
        saveFailed = false;
        // 실패했다가 복구됐을 때, 또는 오래 걸렸을 때만 "저장됨"을 알려요.
        if (wasFailed || $('#saveStatus').dataset.state === 'saving') setSaveStatus('saved');
      } else {
        saveFailed = true;
        setSaveStatus('error', err && err.message);
        retryTimer = setTimeout(() => { if (saveFailed) writeNow(); }, 5000);
      }
      return ok;
    })();
    return inflight;
  }
  function retrySave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    setSaveStatus('saving');
    writeNow();
  }
  // 아직 못 보낸 변경을 지금 보내고, 저장이 끝날 때까지 기다려요. (창 닫기·앱 종료 직전에 써요)
  async function flushAll() {
    const pending = saveTimer !== null;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (pending || dirty || saveFailed) return writeNow();
    if (inflight) return inflight;
    return true;
  }
  const flushSave = () => { flushAll(); };
  function save() {
    if (state.undoSnap) clearUndo(); // 삭제 뒤 다른 수정이 생기면 실행 취소는 만료
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 100);
  }
  // 설치한 앱이 종료·창 닫기 전에 "저장 끝났어?"라고 물어보면 끝날 때까지 기다렸다가 알려 줘요.
  if (window.storage && window.storage.onFlushRequest) window.storage.onFlushRequest(() => flushAll());
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  // ---------- 카테고리 / 목표 / 필터 ----------
  const catById = (id) => (id ? data.categories.find((c) => c.id === id) || null : null);
  const projById = (id) => (id ? data.projects.find((p) => p.id === id) || null : null);
  const catName = (c) => (c.name || '').trim() || '이름 없음';
  // 할 일에 카테고리가 없으면 소속 목표의 카테고리를 따라갑니다.
  const todoCatId = (t) => t.categoryId || projById(t.projectId)?.categoryId || null;
  const evColor = (ev) => catById(ev.categoryId)?.color || ev.color || COLORS[0];
  const catKey = (id) => (catById(id) ? id : NONE);
  const isCatVisible = (id) => !state.hidden.has(catKey(id));

  function matchQ(fields) {
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    return fields.some((f) => (f || '').toLowerCase().includes(q));
  }
  const passEvent = (ev) => isCatVisible(ev.categoryId) && matchQ([ev.title, ev.memo]);
  const passTodo = (t) => isCatVisible(todoCatId(t)) && matchQ([t.title, t.memo, projById(t.projectId)?.title]);
  const passProject = (p) => isCatVisible(p.categoryId) && matchQ([p.title, p.memo]);

  function persistFilter() {
    data.settings.hiddenCategories = [...state.hidden];
    save();
  }

  // 완료한 시각을 함께 저장해 두면 나중에 통계(활동 기록)를 낼 수 있어요.
  function setTodoDone(t, done) {
    t.done = !!done;
    if (t.done) t.completedAt = Date.now();
    else delete t.completedAt;
  }
  // 일정도 할 일처럼 체크할 수 있어요. 반복 일정은 회차(시작 날짜)마다 따로 기록합니다.
  const isDoneOn = (ev, key) => !!(ev.doneOn && ev.doneOn[key]);
  const isOccDone = (ev, o) => isDoneOn(ev, fmtDate(o.start));
  function setOccDone(ev, key, done) {
    if (!ev.doneOn) ev.doneOn = {};
    if (done) ev.doneOn[key] = Date.now();
    else delete ev.doneOn[key];
  }

  function setProjectStatus(p, status) {
    p.status = status;
    if (status === 'done') p.completedAt = Date.now();
    else delete p.completedAt;
  }

  function fillSelect(sel, options) {
    const prev = sel.value;
    sel.replaceChildren(...options.map((o) => h('option', { value: o.value, text: o.label })));
    if (options.some((o) => o.value === prev)) sel.value = prev;
  }
  const catOptions = (emptyLabel) => [
    { value: '', label: emptyLabel },
    ...data.categories.map((c) => ({ value: c.id, label: catName(c) })),
  ];
  const projOptions = (emptyLabel, onlyActive) => [
    { value: '', label: emptyLabel },
    ...data.projects
      .filter((p) => !onlyActive || p.status !== 'done')
      .map((p) => ({ value: p.id, label: p.title + (p.status === 'done' ? ' (완료)' : '') })),
  ];

  // 필터가 한 카테고리만 남겼다면 새 일정의 기본 카테고리로 씁니다.
  function defaultCatForNew() {
    const keys = [...data.categories.map((c) => c.id), NONE].filter((k) => !state.hidden.has(k));
    return keys.length === 1 && keys[0] !== NONE ? keys[0] : '';
  }

  function renderSidebar() {
    const box = $('#sideCats');
    box.replaceChildren();
    const all = [
      ...data.categories.map((c) => ({ key: c.id, id: c.id, name: catName(c), color: c.color })),
      { key: NONE, id: null, name: '미분류', color: UNCAT_COLOR },
    ];
    for (const c of all) {
      const off = state.hidden.has(c.key);
      const toggle = h('button', {
        type: 'button',
        class: 'cat-toggle',
        'aria-pressed': String(!off),
        title: '클릭: 켜기/끄기 · 더블클릭: 이것만 보기',
        onclick: () => {
          if (state.hidden.has(c.key)) state.hidden.delete(c.key);
          else state.hidden.add(c.key);
          persistFilter();
          render();
        },
        ondblclick: () => {
          const others = all.filter((x) => x.key !== c.key).map((x) => x.key);
          const alreadyOnly = others.every((k) => state.hidden.has(k)) && !state.hidden.has(c.key);
          state.hidden = alreadyOnly ? new Set() : new Set(others);
          persistFilter();
          render();
        },
      }, h('span', { class: 'cat-box' }), h('span', { class: 'cat-name', text: c.name }));
      const item = h('div', { class: 'cat-item' + (off ? ' off' : '') }, toggle,
        c.id ? h('button', {
          type: 'button', class: 'cat-edit', title: '이름·색 편집 및 삭제', 'aria-label': `${c.name} 편집`,
          onclick: () => openCatEdit(c.id),
        }, '편집') : null);
      item.style.setProperty('--c', c.color);
      box.append(item);
    }
    $('#fclear').hidden = !(state.hidden.size > 0 || state.q.trim());
    $('#sideToggle').classList.toggle('filtered', state.hidden.size > 0 || !!state.q.trim()); // 좁은 화면에서 필터가 켜져 있음을 알려요

    document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === state.page));
    // 할 일 탭에서 처리할 것 = 안 끝난 할 일(밀린 것 포함) + 밀린 일정
    const openTodos = data.todos.filter((t) => !t.done && passTodo(t)).length
      + collectLate(false).filter((x) => x.o).length;
    const activeGoals = data.projects.filter((p) => p.status !== 'done' && passProject(p)).length;
    $('#navTodoCount').textContent = openTodos ? String(openTodos) : '';
    $('#navGoalCount').textContent = activeGoals ? String(activeGoals) : '';
  }

  // ---------- 날짜 범위 / 일정 수집 ----------
  function visibleDays() {
    const c = startOfDay(state.cursor);
    if (state.view === 'day') return [c];
    if (state.view === 'week') {
      const s = addDays(c, -((c.getDay() - weekStart() + 7) % 7));
      return Array.from({ length: 7 }, (_, i) => addDays(s, i));
    }
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const s = addDays(first, -((first.getDay() - weekStart() + 7) % 7));
    return Array.from({ length: 42 }, (_, i) => addDays(s, i));
  }

  function occurrencesForDays(days, ignoreFilter = false) {
    const from = days[0];
    const to = addDays(days[days.length - 1], 1);
    const out = [];
    for (const ev of data.events) {
      if (!ignoreFilter && !passEvent(ev)) continue;
      try {
        for (const o of occurrencesInRange(ev, from, to)) out.push({ ev, start: o.start, end: o.end, key: o.key });
      } catch (e) {
        console.warn('잘못된 일정 데이터를 건너뜀', ev, e);
      }
    }
    return out;
  }

  function dayOccs(occs, day) {
    const ds = startOfDay(day);
    const de = addDays(ds, 1);
    return occs.filter((o) => o.start < de && (o.end > ds || o.start >= ds));
  }

  // 밀린 일: 날짜가 지났는데 체크 못 한 일.
  //  - 할 일: 기한이 오늘 전이고 미완료
  //  - 일정: 반복하지 않는 일정이 오늘 전에 끝났고 미완료 (이 기능을 쓰기 시작한 날부터)
  //  밀린 일은 캘린더에서 빼고 홈의 "밀린 할 일"에만 보여요. 반복 일정은 캘린더에 그대로 남습니다.
  const isRepeating = (ev) => !!ev.repeat && ev.repeat !== 'none';
  function backlogInfo() {
    const today = startOfDay(new Date());
    return { today, todayKey: fmtDate(today), since: data.settings.taskTrackingSince || fmtDate(today) };
  }
  const isLateTodo = (t, todayKey) => !t.done && !!t.due && t.due < todayKey;
  function isLateOcc(o, info = backlogInfo()) {
    return !isRepeating(o.ev) && o.end <= info.today && fmtDate(o.start) >= info.since && !isOccDone(o.ev, o);
  }
  const calOccs = (days) => {
    const info = backlogInfo();
    return occurrencesForDays(days).filter((o) => !isLateOcc(o, info));
  };

  // 밀린 일 목록 (날짜 오래된 순). ignoreFilter=true면 카테고리 필터를 무시(홈).
  function collectLate(ignoreFilter) {
    const info = backlogInfo();
    const todos = data.todos.filter((t) => isLateTodo(t, info.todayKey) && (ignoreFilter || passTodo(t)));
    const occs = info.since < info.todayKey
      ? occurrencesForDays([parseLocal(info.since), addDays(info.today, -1)], ignoreFilter).filter((o) => isLateOcc(o, info))
      : [];
    return [
      ...todos.map((t) => ({ key: t.due, t })),
      ...occs.map((o) => ({ key: fmtDate(o.start), o })),
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  const shiftDateStr = (str, days) => fmtDate(addDays(parseLocal(str.slice(0, 10)), days)) + str.slice(10);
  function moveLateItem(x, targetKey) {
    if (x.t) { x.t.due = targetKey; return; }
    const ev = x.o.ev;
    const delta = Math.round((parseLocal(targetKey) - parseLocal(fmtDate(x.o.start))) / DAY_MS);
    ev.start = shiftDateStr(ev.start, delta); // 시간·기간은 그대로, 날짜만 이동
    ev.end = shiftDateStr(ev.end, delta);
  }
  function deleteLateItem(x) {
    if (x.t) data.todos = data.todos.filter((t) => t !== x.t);
    else data.events = data.events.filter((e) => e !== x.o.ev);
  }
  function moveAllLate(items, targetKey) {
    for (const x of items) moveLateItem(x, targetKey);
    save();
    render();
  }

  // 밀린 일 한 줄 오른쪽의 처리 버튼: 오늘로 / 내일로 / 날짜 / 삭제
  function lateActions(x) {
    const base = new Date();
    const todayKey = fmtDate(base);
    const tomorrowKey = fmtDate(addDays(base, 1));
    const go = (key) => { moveLateItem(x, key); save(); render(); };
    const btn = (label, onclick, cls = '') => h('button', { type: 'button', class: 'late-btn ' + cls, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);

    const picker = h('input', { type: 'date', class: 'late-date', min: todayKey, tabindex: '-1', 'aria-label': '옮길 날짜' });
    picker.addEventListener('click', (e) => e.stopPropagation());
    picker.addEventListener('change', () => { if (picker.value) go(picker.value); });
    const dateBtn = btn('날짜', () => { try { picker.showPicker(); } catch { picker.focus(); picker.click(); } });

    const del = btn('삭제', () => {
      const snap = takeSnapshot();
      const title = (x.t ? x.t.title : x.o.ev.title) || '제목 없음';
      deleteLateItem(x);
      save();
      render();
      offerUndo(`"${title}"을 지웠어요.`, snap);
    }, 'danger');

    return h('span', { class: 'late-actions' }, btn('오늘로', () => go(todayKey), 'primary'), btn('내일로', () => go(tomorrowKey)), dateBtn, picker, del);
  }

  function lateRow(x, now, todayKey) {
    const row = x.t ? homeTodoRow(x.t, todayKey) : eventTaskRow(x.o, now, 'late');
    row.classList.add('late');
    row.append(lateActions(x));
    return row;
  }

  const isAllDayLike = (o) => o.ev.allDay || o.end - o.start >= DAY_MS;
  const cmpOcc = (a, b) => (isAllDayLike(b) - isAllDayLike(a)) || a.start - b.start;
  const todosForDay = (day) =>
    data.todos.filter((t) => t.due === fmtDate(day) && passTodo(t) && !isLateTodo(t, fmtDate(new Date()))).sort((a, b) => a.done - b.done);
  const projectsForDay = (day) =>
    data.projects.filter((p) => p.due === fmtDate(day) && p.status !== 'done' && passProject(p));

  // ---------- 상단 날짜 선택 (년/월/일 목록) ----------
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  const YEAR_MIN = 1990;
  const YEAR_MAX = 2100;

  function jumpTo(y, m, d) {
    state.cursor = new Date(y, m, Math.min(d, daysInMonth(y, m)));
    render();
  }

  function buildDatePicker() {
    const ys = $('#dp-year');
    for (let y = YEAR_MIN; y <= YEAR_MAX; y++) ys.append(h('option', { value: String(y), text: `${y}년` }));
    const ms = $('#dp-month');
    for (let m = 0; m < 12; m++) ms.append(h('option', { value: String(m), text: `${m + 1}월` }));
    ys.addEventListener('change', () => jumpTo(Number(ys.value), state.cursor.getMonth(), state.cursor.getDate()));
    ms.addEventListener('change', () => jumpTo(state.cursor.getFullYear(), Number(ms.value), state.cursor.getDate()));
    $('#dp-day').addEventListener('change', (e) =>
      jumpTo(state.cursor.getFullYear(), state.cursor.getMonth(), Number(e.target.value)));
  }

  function updateDatePicker() {
    const c = state.cursor;
    const y = c.getFullYear();
    const m = c.getMonth();
    $('#dp-year').value = String(y);
    $('#dp-month').value = String(m);
    const ds = $('#dp-day');
    const n = daysInMonth(y, m);
    if (ds.options.length !== n) {
      ds.replaceChildren(...Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1), text: `${i + 1}일` })));
    }
    ds.value = String(c.getDate());

    const days = visibleDays();
    const a = days[0];
    const b = days[days.length - 1];
    $('#subtitle').textContent = state.view === 'week'
      ? `${a.getMonth() + 1}/${a.getDate()} – ${b.getMonth() + 1}/${b.getDate()} 주`
      : '';

    const now = new Date();
    $('#todayLabel').textContent = `오늘 ${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${DOW[now.getDay()]})`;
  }

  // ---------- 칩 ----------
  // ---------- 끌어서 이동 ----------
  // 반복하지 않는 일정과 할 일 마감일을 끌어서 옮길 수 있어요. (반복 일정은 일정 편집에서 바꿔요)
  const daysBetween = (fromKey, toKey) => Math.round((parseLocal(toKey) - parseLocal(fromKey)) / DAY_MS);
  let dragPayload = null; // { kind: 'ev'|'td', id, from(칩이 있던 날짜) }

  // 일정을 N일, M분 옮깁니다. (날짜만 바꾸면 시간·기간은 그대로)
  function moveEvent(ev, dayDelta, minDelta = 0) {
    const oldKey = ev.start.slice(0, 10);
    if (ev.allDay || ev.start.length === 10) {
      ev.start = shiftDateStr(ev.start, dayDelta);
      ev.end = shiftDateStr(ev.end, dayDelta);
    } else {
      const mv = (str) => {
        const d = new Date(str);
        return fmtDateTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayDelta, d.getHours(), d.getMinutes() + minDelta));
      };
      ev.start = mv(ev.start);
      ev.end = mv(ev.end);
    }
    const newKey = ev.start.slice(0, 10);
    if (ev.doneOn && oldKey !== newKey && ev.doneOn[oldKey]) { // 완료 표시도 같이 이동
      ev.doneOn[newKey] = ev.doneOn[oldKey];
      delete ev.doneOn[oldKey];
    }
  }

  function makeDraggable(el, payload) {
    el.draggable = true;
    el.classList.add('movable');
    el.addEventListener('dragstart', (e) => {
      dragPayload = payload;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'planner-item');
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      dragPayload = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    });
  }

  function makeDropDay(el, day) {
    const key = fmtDate(day);
    el.addEventListener('dragover', (e) => {
      if (!dragPayload) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const p = dragPayload;
      dragPayload = null;
      if (!p || p.from === key) return;
      const snap = takeSnapshot();
      let title;
      if (p.kind === 'ev') {
        const ev = data.events.find((x) => x.id === p.id);
        if (!ev) return;
        moveEvent(ev, daysBetween(p.from, key));
        title = ev.title || '일정';
      } else {
        const t = data.todos.find((x) => x.id === p.id);
        if (!t) return;
        t.due = key;
        title = t.title || '할 일';
      }
      save();
      render();
      offerUndo(`"${title}"을 ${day.getMonth() + 1}월 ${day.getDate()}일로 옮겼어요.`, snap);
    });
  }

  // 주·일 뷰: 시간 칸에서 끌어 시간/날짜 바꾸기 (15분 단위)
  function enableTimeDrag(el, ev, o, days) {
    if (isRepeating(ev)) return;
    el.classList.add('movable');
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const cols = [...document.querySelectorAll('#calendar .tg-col')];
      const rects = cols.map((x) => x.getBoundingClientRect());
      const origIdx = cols.indexOf(el.parentElement);
      const snapMin = (dy) => Math.round(((dy / HOUR_H) * 60) / 15) * 15;
      let moving = false;
      const move = (m) => {
        const dx = m.clientX - sx;
        const dy = m.clientY - sy;
        if (!moving && Math.hypot(dx, dy) < 5) return;
        if (!moving) { moving = true; el.classList.add('dragging'); }
        el.style.transform = `translate(${dx}px, ${(snapMin(dy) / 60) * HOUR_H}px)`;
      };
      const up = (u) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!moving) return;
        el.classList.remove('dragging');
        el.style.transform = '';
        el._justDragged = true;
        setTimeout(() => { el._justDragged = false; }, 0);
        let idx = rects.findIndex((r) => u.clientX >= r.left && u.clientX < r.right);
        if (idx < 0) idx = origIdx;
        const dayDelta = idx - origIdx;
        const minDelta = snapMin(u.clientY - sy);
        if (!dayDelta && !minDelta) return;
        const snap = takeSnapshot();
        moveEvent(ev, dayDelta, minDelta);
        save();
        render();
        const st = new Date(ev.start);
        offerUndo(`"${ev.title || '일정'}"을 ${st.getMonth() + 1}월 ${st.getDate()}일 ${hhmm(st)}로 옮겼어요.`, snap);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function eventChip(o, day) {
    const solid = isAllDayLike(o);
    const repeating = o.ev.repeat && o.ev.repeat !== 'none';
    const name = (repeating ? '↻ ' : '') + (o.ev.title || '(제목 없음)');
    const el = h('div', {
      class: 'chip' + (solid ? ' solid' : '') + (isOccDone(o.ev, o) ? ' done' : ''),
      title: o.ev.title || '',
      onclick: (e) => {
        e.stopPropagation();
        openEventDialog(o.ev, { occDate: fmtDate(o.start) });
      },
    }, solid ? name : `${hhmm(o.start)} ${name}`);
    el.style.setProperty('--c', evColor(o.ev));
    if (!repeating) makeDraggable(el, { kind: 'ev', id: o.ev.id, from: fmtDate(day || o.start) });
    return el;
  }

  function todoChip(t, day) {
    const el = h('div', {
      class: 'chip todo' + (t.done ? ' done' : ''),
      title: t.title,
      onclick: (e) => {
        e.stopPropagation();
        openTodoDialog(t);
      },
    }, `${t.done ? '☑' : '☐'} ${t.title}`);
    const c = catById(todoCatId(t));
    if (c) el.style.setProperty('--c', c.color);
    if (day) makeDraggable(el, { kind: 'td', id: t.id, from: fmtDate(day) });
    return el;
  }

  function projectChip(p) {
    const el = h('div', {
      class: 'chip goal',
      title: `목표일: ${p.title}`,
      onclick: (e) => {
        e.stopPropagation();
        openProjectDialog(p);
      },
    }, `⚑ ${p.title}`);
    el.style.setProperty('--c', catById(p.categoryId)?.color || UNCAT_COLOR);
    return el;
  }

  // ---------- 월 뷰 ----------
  // 좁은 화면(휴대폰)에서는 칸에 일정 이름을 넣으면 거의 안 보여서, 점으로 표시하고
  // 고른 날의 일정을 아래에 목록으로 보여 줘요.
  const narrowMQ = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };
  const isNarrow = () => narrowMQ.matches;

  function renderMonthCompact(root, days, occs, order, todayKey) {
    const keys = days.map(fmtDate);
    const selKey = state.selDay && keys.includes(state.selDay) ? state.selDay
      : keys.includes(todayKey) ? todayKey : fmtDate(state.cursor);
    const selDay = days[keys.indexOf(selKey)] || state.cursor;

    root.append(h('div', { class: 'month-head' },
      order.map((i) => h('div', { class: 'dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: DOW[i] }))));

    const grid = h('div', { class: 'month-grid' });
    for (const day of days) {
      const k = fmtDate(day);
      const dots = [
        ...dayOccs(occs, day).map((o) => ({ c: evColor(o.ev) })),
        ...projectsForDay(day).map((p) => ({ c: catById(p.categoryId)?.color || UNCAT_COLOR })),
        ...todosForDay(day).map((t) => ({ c: catById(todoCatId(t))?.color || 'var(--muted)', todo: true })),
      ];
      const wk = day.getDay() === 0 ? ' sun' : day.getDay() === 6 ? ' sat' : '';
      const hol = holiday(day);
      const cell = h('div', {
        'data-date': k,
        class: 'cell mini' + (day.getMonth() === state.cursor.getMonth() ? '' : ' other') + (k === todayKey ? ' today' : '') + (k === selKey ? ' sel' : ''),
        onclick: () => { state.selDay = k; renderCalendar(); },
      },
      h('div', { class: 'cell-top' }, h('div', { class: 'num' + wk + (hol ? ' hol' : ''), text: String(day.getDate()) })),
      h('div', { class: 'dots' },
        dots.slice(0, 3).map((d) => {
          const dot = h('i', { class: 'dot' + (d.todo ? ' todo' : '') });
          dot.style.setProperty('--c', d.c);
          return dot;
        }),
        dots.length > 3 ? h('span', { class: 'dots-more', text: `+${dots.length - 3}` }) : null));
      grid.append(cell);
    }
    root.append(grid);

    const items = [
      ...dayOccs(occs, selDay).sort(cmpOcc).map((o) => eventChip(o, selDay)),
      ...projectsForDay(selDay).map((p) => projectChip(p)),
      ...todosForDay(selDay).map((t) => todoChip(t, null)),
    ];
    const selHol = holiday(selDay);
    root.append(h('div', { class: 'agenda' },
      h('div', { class: 'agenda-head' },
        h('span', { text: `${selDay.getMonth() + 1}월 ${selDay.getDate()}일 (${DOW[selDay.getDay()]})${selKey === todayKey ? ' · 오늘' : ''}` }),
        selHol ? h('span', { class: 'hol-name', text: selHol.name }) : null),
      items.length ? items : h('div', { class: 'agenda-empty', text: '이 날은 일정이 없어요' }),
      h('button', { type: 'button', class: 'agenda-add', onclick: () => openEventDialog(null, { date: selDay }) }, '+ 이 날 일정 추가')));
  }

  function renderMonth(root) {
    const days = visibleDays();
    const occs = calOccs(days);
    const todayKey = fmtDate(new Date());
    const order = Array.from({ length: 7 }, (_, i) => (weekStart() + i) % 7);

    if (isNarrow()) { renderMonthCompact(root, days, occs, order, todayKey); return; }

    root.append(
      h('div', { class: 'month-head' },
        order.map((i) => h('div', { class: 'dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: DOW[i] }))),
    );

    const grid = h('div', { class: 'month-grid' });
    const MAX = 3;
    for (const day of days) {
      const items = [
        ...dayOccs(occs, day).sort(cmpOcc).map((o) => eventChip(o, day)),
        ...projectsForDay(day).map((p) => projectChip(p)),
        ...todosForDay(day).map((t) => todoChip(t, day)),
      ];
      const shown = items.slice(0, MAX);
      const rest = items.length - shown.length;

      const wk = day.getDay() === 0 ? ' sun' : day.getDay() === 6 ? ' sat' : '';
      const hol = holiday(day);
      const cell = h('div', {
        'data-date': fmtDate(day),
        class: 'cell' +
          (day.getMonth() === state.cursor.getMonth() ? '' : ' other') +
          (fmtDate(day) === todayKey ? ' today' : ''),
        onclick: () => openEventDialog(null, { date: day }),
      }, h('div', { class: 'cell-top' },
        h('div', { class: 'num' + wk + (hol ? ' hol' : ''), text: String(day.getDate()) }),
        hol ? h('span', { class: 'hol-name' + (hol.sub ? ' sub' : ''), text: hol.name, title: hol.name }) : null), shown);

      makeDropDay(cell, day);
      if (rest > 0) {
        cell.append(h('div', {
          class: 'more',
          onclick: (e) => {
            e.stopPropagation();
            state.cursor = day;
            setView('day');
          },
        }, `+${rest}개 더보기`));
      }
      grid.append(cell);
    }
    root.append(grid);
  }

  // ---------- 주/일 뷰 ----------
  function layoutDay(items) {
    items.sort((a, b) => a.s - b.s || b.le - a.le);
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const cols = [];
      for (const it of cluster) {
        let c = cols.findIndex((end) => end <= it.s);
        if (c < 0) { c = cols.length; cols.push(0); }
        cols[c] = it.le;
        it.col = c;
      }
      cluster.forEach((it) => { it.cols = cols.length; });
      cluster = [];
    };
    for (const it of items) {
      if (cluster.length && it.s >= clusterEnd) { flush(); clusterEnd = -1; }
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.le);
    }
    if (cluster.length) flush();
  }

  function renderTimeGrid(root) {
    const days = visibleDays();
    const n = days.length;
    const occs = calOccs(days);
    const todayKey = fmtDate(new Date());
    const cols = `56px repeat(${n}, minmax(0, 1fr))`;

    const head = h('div', { class: 'tg-head' }, h('div'));
    head.style.gridTemplateColumns = cols;
    for (const d of days) {
      const hol = holiday(d);
      head.append(h('div', {
        class: 'tg-dayhead' + (fmtDate(d) === todayKey ? ' today' : ''),
        onclick: () => { state.cursor = d; setView('day'); },
      },
      h('span', { class: 'dow', text: DOW[d.getDay()] }),
      h('span', { class: 'dnum' + (hol ? ' hol' : ''), text: String(d.getDate()) }),
      hol ? h('span', { class: 'hol-name' + (hol.sub ? ' sub' : ''), text: hol.name, title: hol.name }) : null));
    }

    const allday = h('div', { class: 'tg-allday' }, h('div', { class: 'tg-label', text: '종일' }));
    allday.style.gridTemplateColumns = cols;
    for (const d of days) {
      allday.append(h('div', {
        'data-date': fmtDate(d),
        class: 'tg-allcell',
        onclick: () => openEventDialog(null, { date: d, allDay: true }),
      },
      dayOccs(occs, d).filter(isAllDayLike).sort(cmpOcc).map((o) => eventChip(o, d)),
      projectsForDay(d).map((p) => projectChip(p)),
      todosForDay(d).map((t) => todoChip(t, d))));
      makeDropDay(allday.lastChild, d);
    }

    const gutter = h('div', { class: 'tg-gutter' });
    for (let hr = 1; hr < 24; hr++) {
      gutter.append(h('div', { class: 'tg-hour', style: { top: `${hr * HOUR_H - 7}px` }, text: `${pad2(hr)}:00` }));
    }
    const inner = h('div', { class: 'tg-inner' }, gutter);
    inner.style.gridTemplateColumns = cols;
    inner.style.height = `${24 * HOUR_H}px`;

    for (const d of days) {
      const ds = startOfDay(d);
      const col = h('div', { 'data-date': fmtDate(d), class: 'tg-col' + (fmtDate(d) === todayKey ? ' today' : '') });
      col.addEventListener('click', (e) => {
        if (e.target !== col) return;
        const rect = col.getBoundingClientRect();
        const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor(((e.clientY - rect.top) / HOUR_H) * 2) * 30));
        openEventDialog(null, { start: new Date(ds.getFullYear(), ds.getMonth(), ds.getDate(), 0, mins) });
      });

      const items = dayOccs(occs, d)
        .filter((o) => !isAllDayLike(o))
        .map((o) => {
          const s = Math.min(Math.max(0, (o.start - ds) / 60000), 24 * 60 - 20);
          const e = Math.min(24 * 60, (o.end - ds) / 60000);
          return { o, s, e: Math.max(e, s + 20), le: Math.max(e, s + 30) };
        });
      layoutDay(items);

      for (const it of items) {
        const ev = it.o.ev;
        const el = h('div', {
          class: 'tg-event' + (isOccDone(ev, it.o) ? ' done' : ''),
          title: ev.title || '',
          style: {
            top: `${(it.s / 60) * HOUR_H}px`,
            height: `${Math.max(16, ((it.e - it.s) / 60) * HOUR_H - 2)}px`,
            left: `calc(${(it.col / it.cols) * 100}% + 1px)`,
            width: `calc(${100 / it.cols}% - 3px)`,
          },
          onclick: (e) => {
            e.stopPropagation();
            if (e.currentTarget._justDragged) return; // 끌고 난 직후의 클릭은 무시
            openEventDialog(ev, { occDate: fmtDate(it.o.start) });
          },
        },
        h('div', { class: 't', text: (ev.repeat && ev.repeat !== 'none' ? '↻ ' : '') + (ev.title || '(제목 없음)') }),
        h('div', { class: 'time', text: `${hhmm(it.o.start)} – ${hhmm(it.o.end)}` }));
        el.style.setProperty('--c', evColor(ev));
        enableTimeDrag(el, ev, it.o, days);
        col.append(el);
      }

      if (fmtDate(d) === todayKey) {
        const now = new Date();
        col.append(h('div', { class: 'now-line', style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H}px` } }));
      }
      inner.append(col);
    }

    const body = h('div', { class: 'tg-body' }, inner);
    body.addEventListener('scroll', () => { state.scrollTop = body.scrollTop; });
    root.append(head, allday, body);
    body.scrollTop = state.scrollTop;
  }

  // ---------- 전체 렌더 ----------
  function renderCalendar() {
    const root = $('#calendar');
    root.replaceChildren();
    root.classList.toggle('compact', state.view === 'month' && isNarrow());
    if (state.view === 'month') renderMonth(root);
    else renderTimeGrid(root);
    updateDatePicker();
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  }

  const cmpTodo = (a, b) =>
    (a.done - b.done) ||
    ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) ||
    ((b.priority || 0) - (a.priority || 0)) ||
    ((a.createdAt || 0) - (b.createdAt || 0));

  function renderTodos() {
    const list = $('#todoList');
    list.replaceChildren();
    const lateAll = collectLate(false);
    $('#lateTabCount').textContent = lateAll.length ? String(lateAll.length) : '';
    $('#lateBar').hidden = state.todoFilter !== 'late';
    if (state.todoFilter === 'late') {
      const now = new Date();
      const todayKey = fmtDate(now);
      $('#lateAllBtn').disabled = !lateAll.length;
      $('#lateAllBtn').onclick = () => moveAllLate(lateAll, todayKey);
      if (!lateAll.length) list.append(h('div', { class: 'empty', text: '밀린 일이 없어요 🎉' }));
      for (const x of lateAll) list.append(lateRow(x, now, todayKey));
      $('#todoCount').textContent = `밀린 일 ${lateAll.length}개`;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.todoFilter));
      return;
    }
    // 밀린 할 일은 "밀린 일" 탭에서 따로 봅니다. (전체·진행 중 목록에서는 제외)
    const todayKeyL = fmtDate(new Date());
    const visible = data.todos.filter((t) => passTodo(t) && !isLateTodo(t, todayKeyL));
    let todos = visible.slice();
    if (state.todoFilter === 'active') todos = todos.filter((t) => !t.done);
    if (state.todoFilter === 'done') todos = todos.filter((t) => t.done);
    todos.sort(cmpTodo);

    const todayKey = fmtDate(new Date());
    if (!todos.length) {
      list.append(h('div', {
        class: 'empty',
        text: data.todos.length && !visible.length ? '필터에 맞는 할 일이 없어요'
          : state.todoFilter === 'done' ? '완료한 할 일이 없어요' : '할 일을 추가해 보세요',
      }));
    }
    for (const t of todos) {
      let badge = null;
      if (t.due) {
        const cls = !t.done && t.due < todayKey ? ' overdue' : t.due === todayKey ? ' today' : '';
        badge = h('span', { class: 'badge' + cls, text: t.due === todayKey ? '오늘' : shortDate(t.due) });
      }
      const box = h('input', { type: 'checkbox', 'aria-label': '완료' });
      box.checked = !!t.done;
      box.addEventListener('change', () => {
        setTodoDone(t, box.checked);
        save();
        render();
      });
      const cat = catById(todoCatId(t));
      const proj = projById(t.projectId);
      const sub = [proj ? proj.title : null, cat ? catName(cat) : null].filter(Boolean).join(' · ');
      list.append(h('div', { class: 'todo' + (t.done ? ' done' : '') },
        box,
        h('span', { class: 'prio p' + (t.priority ?? 1), title: ['낮음', '보통', '높음'][t.priority ?? 1] }),
        h('span', { class: 'todo-main' },
          h('span', { class: 'todo-title', text: t.title, onclick: () => openTodoDialog(t) }),
          sub ? h('span', { class: 'todo-sub' },
            cat ? h('span', { class: 'dot', style: { background: cat.color } }) : null, sub) : null),
        badge));
    }
    $('#todoCount').textContent = `남은 일 ${visible.filter((t) => !t.done).length}개`;
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.todoFilter));
  }

  // ---------- 목표 ----------
  function projectStats(p) {
    const ts = data.todos.filter((t) => t.projectId === p.id);
    const done = ts.filter((t) => t.done).length;
    const total = ts.length;
    const pct = p.status === 'done' ? 100 : total ? Math.round((done / total) * 100) : 0;
    return { ts, done, total, pct };
  }

  function ddayInfo(due, finished) {
    if (!due) return null;
    const diff = Math.round((parseLocal(due) - startOfDay(new Date())) / DAY_MS);
    const text = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
    const cls = finished ? '' : diff < 0 ? ' overdue' : diff <= 3 ? ' today' : '';
    return { text, cls };
  }

  function miniTodo(t) {
    const box = h('input', { type: 'checkbox', 'aria-label': '완료' });
    box.checked = !!t.done;
    box.addEventListener('change', () => { setTodoDone(t, box.checked); save(); render(); });
    return h('div', { class: 'mini' + (t.done ? ' done' : '') },
      box,
      h('span', { class: 'mini-title', text: t.title, onclick: () => openTodoDialog(t) }),
      t.due ? h('span', { class: 'muted', text: shortDate(t.due) }) : null);
  }

  function projectCard(p) {
    const st = projectStats(p);
    const cat = catById(p.categoryId);
    const color = cat ? cat.color : UNCAT_COLOR;
    const finished = p.status === 'done';
    const dd = ddayInfo(p.due, finished);
    const rows = st.ts.slice().sort(cmpTodo);
    const limit = state.expanded.has(p.id) ? rows.length : 4;

    const meta = [cat ? catName(cat) : '미분류', p.due ? `목표일 ${shortDate(p.due)}` : null].filter(Boolean).join(' · ');
    const countText = st.total
      ? `${st.done}/${st.total} 완료 · ${st.pct}%`
      : finished ? '완료' : '할 일을 추가하면 진행률이 보여요';

    const input = h('input', { placeholder: '이 목표에 할 일 추가', 'aria-label': `${p.title}에 할 일 추가`, 'data-padd': p.id });
    const form = h('form', {
      class: 'proj-add',
      autocomplete: 'off',
      onsubmit: (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        data.todos.push({
          id: uid(), title, done: false, due: null, priority: 1, memo: '',
          categoryId: null, projectId: p.id, createdAt: Date.now(),
        });
        save();
        render();
        const again = [...document.querySelectorAll('[data-padd]')].find((el) => el.dataset.padd === p.id);
        if (again) again.focus();
      },
    }, input);

    const extra = [];
    if (rows.length > 4) {
      extra.push(h('button', {
        type: 'button',
        class: 'link-btn',
        onclick: () => {
          if (state.expanded.has(p.id)) state.expanded.delete(p.id); else state.expanded.add(p.id);
          renderProjects();
        },
      }, state.expanded.has(p.id) ? '접기' : `+${rows.length - 4}개 더 보기`));
    }
    if (!finished && st.total > 0 && st.done === st.total) {
      extra.push(h('button', {
        type: 'button',
        class: 'link-btn',
        onclick: () => { setProjectStatus(p, 'done'); save(); render(); },
      }, '모두 끝났어요 · 완료로 표시'));
    }

    return h('article', { class: 'proj' + (finished ? ' done' : '') },
      h('div', { class: 'proj-head', onclick: () => openProjectDialog(p) },
        h('span', { class: 'dot', style: { background: color } }),
        h('span', { class: 'proj-title', text: p.title }),
        dd ? h('span', { class: 'badge' + dd.cls, text: dd.text }) : null),
      h('div', { class: 'proj-meta muted', text: meta }),
      h('div', {
        class: 'progress', role: 'progressbar', 'aria-label': `${p.title} 진행률`,
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(st.pct),
      }, h('span', { style: { width: `${st.pct}%`, background: color } })),
      h('div', { class: 'proj-count muted', text: countText }),
      rows.slice(0, limit).map((t) => miniTodo(t)),
      extra.length ? h('div', { class: 'proj-extra' }, extra) : null,
      form);
  }

  function renderProjects() {
    const list = $('#projList');
    list.replaceChildren();
    const visible = data.projects.filter(passProject);
    let ps = visible.slice();
    if (state.projFilter === 'active') ps = ps.filter((p) => p.status !== 'done');
    if (state.projFilter === 'done') ps = ps.filter((p) => p.status === 'done');
    ps.sort((a, b) =>
      ((a.status === 'done') - (b.status === 'done')) ||
      ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) ||
      ((a.createdAt || 0) - (b.createdAt || 0)));

    if (!ps.length) {
      list.append(h('div', {
        class: 'empty',
        text: data.projects.length && !visible.length ? '필터에 맞는 목표가 없어요'
          : state.projFilter === 'done' ? '완료한 목표가 없어요' : '이루고 싶은 목표를 추가해 보세요',
      }));
    }
    for (const p of ps) list.append(projectCard(p));
    $('#projCount').textContent = `진행 중 ${visible.filter((p) => p.status !== 'done').length}개`;
    document.querySelectorAll('[data-pfilter]').forEach((b) => b.classList.toggle('active', b.dataset.pfilter === state.projFilter));
  }

  function renderQuickSelects() {
    fillSelect($('#todoNewCat'), catOptions('미분류'));
    fillSelect($('#todoNewProj'), projOptions('목표 없음', true));
    fillSelect($('#projNewCat'), catOptions('미분류'));
  }

  // ---------- 홈 ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  // 원형 진행 표시. color는 CSS 색(변수 가능), 가운데에 kids를 넣습니다.
  function ring(pct, color, size, stroke, ...kids) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `${pct}%` });
    const track = svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke });
    track.style.stroke = 'var(--border)';
    svg.append(track);
    if (pct > 0) {
      const arc = svgEl('circle', {
        cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke, 'stroke-linecap': 'round',
        'stroke-dasharray': `${(c * Math.min(pct, 100)) / 100} ${c}`,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      });
      arc.style.stroke = color;
      svg.append(arc);
    }
    return h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } },
      svg, h('div', { class: 'ring-center' }, kids));
  }

  function miniCalendar() {
    const c = state.miniCursor;
    const y = c.getFullYear();
    const m = c.getMonth();
    const first = new Date(y, m, 1);
    const start = addDays(first, -((first.getDay() - weekStart() + 7) % 7));
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));

    // 점 표시: 일정 / 할 일(마감) / 목표일. 홈은 필터와 상관없이 전체를 봅니다.
    const info = backlogInfo();
    const occs = occurrencesForDays(days, true).filter((o) => !isLateOcc(o, info));
    const todoDays = new Set(data.todos.filter((t) => !t.done && t.due && t.due >= info.todayKey).map((t) => t.due));
    const goalDays = new Set(data.projects.filter((p) => p.status !== 'done' && p.due).map((p) => p.due));
    const todayKey = fmtDate(new Date());
    const order = Array.from({ length: 7 }, (_, i) => (weekStart() + i) % 7);

    const grid = h('div', { class: 'mc-grid' },
      order.map((i) => h('div', { class: 'mc-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: DOW[i] })));
    for (const d of days) {
      const key = fmtDate(d);
      const dots = [];
      if (dayOccs(occs, d).length) dots.push(h('i', { class: 'dot-ev' }));
      if (todoDays.has(key)) dots.push(h('i', { class: 'dot-td' }));
      if (goalDays.has(key)) dots.push(h('i', { class: 'dot-gl' }));
      grid.append(h('button', {
        type: 'button',
        class: 'mc-day' + (d.getMonth() === m ? '' : ' other') + (key === todayKey ? ' today' : '') +
          (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : '') + (holiday(d) ? ' hol' : ''),
        'aria-label': `${d.getMonth() + 1}월 ${d.getDate()}일` + (holiday(d) ? ` (${holiday(d).name})` : ''),
        title: holiday(d) ? holiday(d).name : null,
        onclick: () => { state.cursor = new Date(d); state.view = 'day'; goPage('calendar'); },
      }, h('span', { class: 'mc-num', text: String(d.getDate()) }), h('span', { class: 'mc-dots' }, dots)));
    }

    const shift = (n) => { state.miniCursor = new Date(y, m + n, 1); renderHome(); };
    return h('div', { class: 'card' },
      h('div', { class: 'mc-head' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '이전 달', onclick: () => shift(-1) }, '‹'),
        h('button', {
          type: 'button', class: 'mc-title', title: '이번 달로',
          onclick: () => { const n = new Date(); state.miniCursor = new Date(n.getFullYear(), n.getMonth(), 1); renderHome(); },
        }, `${y}년 ${m + 1}월`),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '다음 달', onclick: () => shift(1) }, '›')),
      grid,
      h('div', { class: 'mc-legend' },
        h('span', {}, h('i', { class: 'dot-ev' }), '일정'),
        h('span', {}, h('i', { class: 'dot-td' }), '할 일 마감'),
        h('span', {}, h('i', { class: 'dot-gl' }), '목표일')));
  }

  // 일정 한 줄(체크 가능). mode: 'today' 오늘 일정 | 'late' 지난 일정
  function eventTaskRow(o, now, mode) {
    const key = fmtDate(o.start);
    const done = isOccDone(o.ev, o);
    const allDay = isAllDayLike(o);
    const live = mode === 'today' && !allDay && o.start <= now && now < o.end;
    const past = mode === 'today' && !allDay && o.end <= now;
    const repeating = o.ev.repeat && o.ev.repeat !== 'none';
    const box = h('input', { type: 'checkbox', 'aria-label': '일정 완료' });
    box.checked = done;
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => { setOccDone(o.ev, key, box.checked); save(); render(); });
    const when = mode === 'late'
      ? `${shortDate(key)} ${allDay ? '종일' : hhmm(o.start)}`
      : allDay ? '종일' : `${hhmm(o.start)} – ${hhmm(o.end)}`;
    const row = h('div', {
      class: 'sch' + (done ? ' done' : ''),
      onclick: () => openEventDialog(o.ev, { occDate: key }),
    },
    box,
    h('span', { class: 'sch-bar' }),
    h('span', { class: 'sch-time', text: when }),
    h('span', { class: 'sch-title', text: (repeating ? '↻ ' : '') + (o.ev.title || '(제목 없음)') }),
    done ? null : live ? h('span', { class: 'tag now', text: '진행 중' }) : past ? h('span', { class: 'tag', text: '시간 지남' }) : null);
    row.style.setProperty('--c', evColor(o.ev));
    return row;
  }

  function homeTodoRow(t, todayKey) {
    const box = h('input', { type: 'checkbox', 'aria-label': '완료' });
    box.checked = !!t.done;
    box.addEventListener('change', () => { setTodoDone(t, box.checked); save(); render(); });
    const proj = projById(t.projectId);
    const overdue = !t.done && t.due && t.due < todayKey;
    const late = overdue ? Math.round((parseLocal(todayKey) - parseLocal(t.due)) / DAY_MS) : 0;
    return h('div', { class: 'todo' + (t.done ? ' done' : '') },
      box,
      h('span', { class: 'prio p' + (t.priority ?? 1), title: ['낮음', '보통', '높음'][t.priority ?? 1] }),
      h('span', { class: 'todo-main' },
        h('span', { class: 'todo-title', text: t.title, onclick: () => openTodoDialog(t) }),
        proj ? h('span', { class: 'todo-sub', text: proj.title }) : null),
      overdue ? h('span', { class: 'badge overdue', text: `${late}일 지남` }) : null);
  }

  const LATE_SHOWN = 5;

  function renderHome() {
    const root = $('#homeBody');
    root.replaceChildren();
    const now = new Date();
    const today = startOfDay(now);
    const todayKey = fmtDate(today);
    const todayHol = holiday(now);
    $('#homeDate').replaceChildren(`${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${DOW[now.getDay()]})`,
      ...(todayHol ? [h('span', { class: 'home-hol', text: todayHol.name })] : []));

    // 홈은 필터와 상관없이 전체를 봅니다.
    const todayOccs = dayOccs(occurrencesForDays([today], true), today);
    const todayTodos = data.todos.filter((t) => t.due === todayKey);

    // 밀린 할 일 = 기한 지난 할 일 + 지난 일정(반복 일정 제외). 체크하거나 옮기거나 지우기 전까지 남아요.
    const lateItems = collectLate(true);

    // 오늘: 할 일 + 일정을 한 목록에 (끝낸 것은 아래로)
    const todayItems = [
      ...todayOccs.map((o) => ({ o, done: isOccDone(o.ev, o), order: isAllDayLike(o) ? 1 : 0, at: +o.start })),
      ...todayTodos.map((t) => ({ t, done: !!t.done, order: 2, at: 0 })),
    ].sort((a, b) => (a.done - b.done) || (a.order - b.order) || (a.at - b.at));
    const total = todayItems.length;
    const doneCount = todayItems.filter((x) => x.done).length;
    const pct = total ? Math.round((doneCount / total) * 100) : 0;

    // --- 요약 타일
    const ringCard = h('div', { class: 'card stat-ring-card' },
      h('div', { class: 'stat-ring' },
        ring(pct, 'var(--accent)', 104, 11, h('span', { text: `${pct}%` })),
        h('div', {},
          h('div', { class: 'stat-label', text: '오늘 할 일 완료' }),
          h('div', { class: 'stat-num', text: total ? `${doneCount}/${total}` : '0' }),
          h('div', {
            class: 'stat-label',
            text: !total ? '오늘 할 일과 일정이 없어요'
              : doneCount === total ? '오늘 할 일을 모두 끝냈어요'
                : `${total - doneCount}개 남았어요`,
          }))));
    const lateTile = h('div', { class: 'card stat-tile' },
      h('div', { class: 'stat-label', text: '밀린 할 일' }),
      h('div', { class: 'stat-num' + (lateItems.length ? ' warn' : ''), text: String(lateItems.length) }),
      h('div', { class: 'stat-label', text: lateItems.length ? '아래 목록에서 정리해 보세요' : '밀린 일이 없어요' }));

    // --- 밀린 할 일 (있을 때만)
    let lateCard = null;
    if (lateItems.length) {
      const shown = state.lateExpanded ? lateItems : lateItems.slice(0, LATE_SHOWN);
      lateCard = h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', { text: `밀린 할 일 ${lateItems.length}` }),
          h('span', { class: 'card-links' },
            lateItems.length > LATE_SHOWN
              ? h('button', { type: 'button', class: 'link-btn', onclick: () => { state.lateExpanded = !state.lateExpanded; renderHome(); } },
                state.lateExpanded ? '접기' : `+${lateItems.length - LATE_SHOWN}개 더 보기`)
              : null,
            h('button', { type: 'button', class: 'link-btn', onclick: () => { state.todoFilter = 'late'; goPage('todos'); } }, '할 일에서 보기'),
            h('button', { type: 'button', class: 'link-btn', onclick: () => moveAllLate(lateItems, todayKey) }, '모두 오늘로'))),
        shown.map((x) => lateRow(x, now, todayKey)));
    }

    // --- 오늘 할 일 (일정 포함)
    const quick = h('input', { id: 'homeQuick', placeholder: '오늘 할 일 추가 후 Enter', 'aria-label': '오늘 할 일 추가' });
    const quickForm = h('form', {
      class: 'home-add',
      autocomplete: 'off',
      onsubmit: (e) => {
        e.preventDefault();
        const title = quick.value.trim();
        if (!title) return;
        data.todos.push({
          id: uid(), title, done: false, due: todayKey, priority: 1, memo: '',
          categoryId: null, projectId: null, createdAt: Date.now(),
        });
        save();
        render();
        const again = $('#homeQuick');
        if (again) again.focus();
      },
    }, quick);
    const todayCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: '오늘 할 일' }),
        h('span', { class: 'card-links' },
          h('button', { type: 'button', class: 'link-btn', onclick: () => { state.cursor = new Date(); state.view = 'day'; goPage('calendar'); } }, '캘린더에서 보기'),
          h('button', { type: 'button', class: 'link-btn', onclick: () => goPage('todos') }, '할 일 전체'))),
      todayItems.length
        ? todayItems.map((x) => (x.t ? homeTodoRow(x.t, todayKey) : eventTaskRow(x.o, now, 'today')))
        : h('div', { class: 'empty-inline' }, '오늘 할 일과 일정이 없어요.',
          h('button', { type: 'button', class: 'btn', onclick: () => openEventDialog(null, { date: today }) }, '+ 일정 추가')),
      quickForm);

    // --- 목표 (기한이 가까운 순 4개)
    const goals = data.projects.filter((p) => p.status !== 'done')
      .sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) || ((a.createdAt || 0) - (b.createdAt || 0)))
      .slice(0, 4);
    const goalCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: '목표 달성률' }),
        h('button', { type: 'button', class: 'link-btn', onclick: () => goPage('goals') }, '전체 보기')),
      goals.length ? goals.map((p) => {
        const st = projectStats(p);
        const color = catById(p.categoryId)?.color || UNCAT_COLOR;
        const dd = ddayInfo(p.due, false);
        return h('div', { class: 'goal-row', onclick: () => goPage('goals') },
          ring(st.pct, color, 54, 7, h('span', { text: `${st.pct}%` })),
          h('div', { class: 'goal-info' },
            h('span', { class: 'goal-title', text: p.title }),
            h('span', { class: 'muted', text: st.total ? `${st.done}/${st.total} 완료` : '할 일을 연결해 보세요' })),
          dd ? h('span', { class: 'badge' + dd.cls, text: dd.text }) : null);
      }) : h('div', { class: 'empty-inline' }, '진행 중인 목표가 없어요.',
        h('button', { type: 'button', class: 'btn', onclick: () => goPage('goals') }, '목표 만들기')));

    root.append(h('div', { class: 'home' },
      h('div', { class: 'home-col' }, miniCalendar(), goalCard),
      h('div', { class: 'home-col' }, h('div', { class: 'stats-row' }, ringCard, lateTile), lateCard, todayCard)));
  }

  // ---------- 빠른 추가 ----------
  const quickDlg = $('#quickDialog');
  const quickParsed = () => window.QuickAdd.parse($('#quickInput').value, new Date(), data.categories);

  // 종류 선택(자동/일정/할 일)을 반영한 최종 결과. 일정↔할 일 전환 시 날짜·시간을 맞춰 줍니다.
  function quickResult() {
    const r = quickParsed();
    if (state.quickKind === 'auto' || r.kind === state.quickKind) return r;
    if (state.quickKind === 'event') {
      const d = r.date || fmtDate(new Date());
      return { ...r, kind: 'event', date: d, allDay: true, start: d, end: d };
    }
    return { ...r, kind: 'todo', allDay: false, start: null, end: null }; // 날짜는 마감일로 유지
  }

  function describeQuick(r) {
    const dateText = (key) => {
      const d = parseLocal(key);
      const diff = Math.round((d - startOfDay(new Date())) / DAY_MS);
      const rel = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === 2 ? '모레' : '';
      return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})${rel ? ' ' + rel : ''}`;
    };
    const cat = r.categoryId ? catById(r.categoryId) : null;
    const parts = [];
    if (r.kind === 'event') {
      if (r.allDay) parts.push(`${dateText(r.date)} 종일`);
      else parts.push(`${dateText(r.date)} ${r.start.slice(11)}–${r.end.slice(11)}`);
    } else {
      parts.push(r.date ? `${dateText(r.date)}까지` : '마감일 없음');
    }
    if (cat) parts.push(catName(cat));
    if (r.priority === 2) parts.push('중요');
    return { kindLabel: r.kind === 'event' ? '일정' : '할 일', text: parts.join(' · ') };
  }

  function renderQuickPreview() {
    const box = $('#quickPreview');
    const r = quickResult();
    document.querySelectorAll('[data-qkind]').forEach((b) => b.classList.toggle('active', b.dataset.qkind === state.quickKind));
    $('#quickOk').disabled = r.empty || !!r.invalid;
    box.replaceChildren();
    if (r.invalid) { box.append(h('span', { class: 'error', text: r.error || '날짜와 시간을 확인해 주세요.' })); return; }
    if (r.empty) { box.append(h('span', { class: 'muted', text: '내용을 입력하면 어떻게 만들어질지 여기에 보여 드려요.' })); return; }
    const d = describeQuick(r);
    box.append(h('span', { class: 'qk ' + r.kind, text: d.kindLabel }), h('b', { text: r.title }), h('span', { class: 'muted', text: d.text }));
  }

  function openQuickDialog() {
    if (quickDlg.open) return;
    state.quickKind = 'auto';
    $('#quickInput').value = '';
    renderQuickPreview();
    quickDlg.showModal();
    $('#quickInput').focus();
  }

  function submitQuick() {
    const r = quickResult();
    if (r.empty || r.invalid) return;
    const snap = takeSnapshot();
    if (r.kind === 'event') {
      const cat = r.categoryId ? catById(r.categoryId) : null;
      data.events.push({
        id: uid(), title: r.title, memo: '', color: cat ? cat.color : COLORS[0], categoryId: r.categoryId || null,
        allDay: r.allDay, start: r.start, end: r.end, repeat: 'none', repeatInterval: 1, repeatUntil: null,
        exceptions: [], doneOn: {}, reminder: null,
      });
    } else {
      data.todos.push({
        id: uid(), title: r.title, done: false, due: r.date, priority: r.priority, memo: '',
        categoryId: r.categoryId || null, projectId: null, createdAt: Date.now(),
      });
    }
    save();
    quickDlg.close();
    render();
    const d = describeQuick(r);
    offerUndo(`${d.kindLabel}을 만들었어요: ${r.title} (${d.text})`, snap);
  }

  // ---------- 통계 ----------
  function statDays(kind) {
    const today = startOfDay(new Date());
    let from;
    let to;
    if (kind === 'week') { from = addDays(today, -((today.getDay() - weekStart() + 7) % 7)); to = addDays(from, 6); }
    else if (kind === 'month') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else { from = addDays(today, -29); to = today; }
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(startOfDay(d));
    return days;
  }

  // 날짜별 완료 기록: 할 일은 completedAt, 일정은 doneOn(체크한 시각)으로 셉니다.
  function completionLog() {
    const todos = {};
    const events = {};
    for (const t of data.todos) {
      if (t.done && typeof t.completedAt === 'number') { const k = fmtDate(new Date(t.completedAt)); todos[k] = (todos[k] || 0) + 1; }
    }
    for (const ev of data.events) {
      for (const v of Object.values(ev.doneOn || {})) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 1e11) continue;
        const k = fmtDate(new Date(v));
        events[k] = (events[k] || 0) + 1;
      }
    }
    return { todos, events, at: (k) => (todos[k] || 0) + (events[k] || 0) };
  }

  const hoursText = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? `${Math.round(n)}시간` : `${n.toFixed(1)}시간`);

  // 일별 완료 수 막대그래프(SVG, 한 가지 색). 최댓값과 오늘만 숫자를 붙이고, 나머지는 마우스를 올리면 보여요.
  function dailyChart(days, valueOf, todayKey, kind) {
    const W = 640; const H = 200; const pl = 30; const pr = 8; const pt = 20; const pb = 26;
    const vals = days.map((d) => valueOf(fmtDate(d)));
    const max = Math.max(...vals, 0);
    const yMax = Math.max(2, max % 2 ? max + 1 : max);
    const slot = (W - pl - pr) / days.length;
    const bw = Math.min(26, slot * 0.62);
    const base = H - pb;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'stat-svg', role: 'img', 'aria-label': '일별 완료 수 막대그래프' });
    const line = (y, dash) => {
      const l = svgEl('line', { x1: pl, x2: W - pr, y1: y, y2: y, 'stroke-width': 1 });
      l.style.stroke = 'var(--border)';
      if (dash) l.setAttribute('stroke-dasharray', '3 4');
      return l;
    };
    const text = (x, y, str, anchor, strong) => {
      const t = svgEl('text', { x, y, 'text-anchor': anchor, 'font-size': 11 });
      t.style.fill = strong ? 'var(--text)' : 'var(--muted)';
      if (strong) t.style.fontWeight = '700';
      t.textContent = str;
      return t;
    };
    svg.append(line(pt, true), line(base, false), text(pl - 6, pt + 4, String(yMax), 'end'), text(pl - 6, base + 4, '0', 'end'));
    const maxIdx = max > 0 ? vals.indexOf(max) : -1;
    days.forEach((d, i) => {
      const k = fmtDate(d);
      const v = vals[i];
      const x = pl + i * slot + (slot - bw) / 2;
      const isToday = k === todayKey;
      if (v > 0) {
        const hh = (v / yMax) * (base - pt);
        const y = base - hh;
        const r = Math.min(4, hh / 2);
        const bar = svgEl('path', { d: `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z` });
        bar.style.fill = 'var(--accent)';
        svg.append(bar);
        if (i === maxIdx || isToday) svg.append(text(x + bw / 2, y - 5, String(v), 'middle', true));
      }
      const showLabel = kind === 'week' || days.length <= 10 || i % 5 === 0 || isToday;
      if (showLabel) svg.append(text(x + bw / 2, H - 8, kind === 'week' ? DOW[d.getDay()] : String(d.getDate()), 'middle', isToday));
      const hit = svgEl('rect', { x: pl + i * slot, y: pt, width: slot, height: base - pt, fill: 'transparent', class: 'stat-hit' });
      const tip = svgEl('title');
      tip.textContent = `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]}): ${v}개 완료`;
      hit.append(tip);
      svg.append(hit);
    });
    return svg;
  }

  function renderStats() {
    const root = $('#statsBody');
    root.replaceChildren();
    document.querySelectorAll('[data-stat]').forEach((b) => b.classList.toggle('active', b.dataset.stat === state.statRange));
    const now = new Date();
    const todayKey = fmtDate(now);
    const days = statDays(state.statRange);
    const fromKey = fmtDate(days[0]);
    const toKey = fmtDate(days[days.length - 1]);
    const log = completionLog();
    const inRange = (k) => k >= fromKey && k <= toKey;

    // 이 기간에 끝낸 일
    const todosDone = Object.entries(log.todos).filter(([k]) => inRange(k)).reduce((n, [, v]) => n + v, 0);
    const eventsDone = Object.entries(log.events).filter(([k]) => inRange(k)).reduce((n, [, v]) => n + v, 0);
    const doneTotal = todosDone + eventsDone;

    // 달성률: 오늘까지 처리했어야 하는 할 일 + 이미 끝난 일정 중 끝낸 비율
    const since = data.settings.taskTrackingSince || todayKey;
    const dueTodos = data.todos.filter((t) => t.due && inRange(t.due) && t.due <= todayKey);
    const rangeOccs = occurrencesForDays(days, true).filter((o) => o.start >= days[0] && o.start < addDays(days[days.length - 1], 1));
    const dueOccs = rangeOccs.filter((o) => fmtDate(o.start) >= since && (o.end <= now || isOccDone(o.ev, o)));
    const dueTotal = dueTodos.length + dueOccs.length;
    const dueDone = dueTodos.filter((t) => t.done).length + dueOccs.filter((o) => isOccDone(o.ev, o)).length;
    const rate = dueTotal ? Math.round((dueDone / dueTotal) * 100) : null;

    // 연속 달성일(오늘 아직 안 했으면 어제까지)
    let cur = startOfDay(now);
    if (!log.at(fmtDate(cur))) cur = addDays(cur, -1);
    let streak = 0;
    while (log.at(fmtDate(cur)) && streak < 3650) { streak++; cur = addDays(cur, -1); }

    // 카테고리별 일정 시간
    const hours = new Map();
    for (const o of rangeOccs) {
      if (isAllDayLike(o)) continue;
      const k = o.ev.categoryId && catById(o.ev.categoryId) ? o.ev.categoryId : NONE;
      hours.set(k, (hours.get(k) || 0) + (o.end - o.start) / 36e5);
    }
    const hourRows = [...hours.entries()].sort((a, b) => b[1] - a[1]);
    const hourTotal = hourRows.reduce((n, [, v]) => n + v, 0);
    const hourMax = hourRows.length ? hourRows[0][1] : 1;

    const tile = (label, value, sub, tip) => h('div', { class: 'card stat-tile', title: tip || '' },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-num', text: value }),
      h('div', { class: 'stat-label', text: sub }));

    // 두 숫자는 기준이 달라요: "끝낸 일"은 체크한 날짜, "기한 달성률"은 기한(일정 날짜)이 이 기간인 항목.
    const tiles = h('div', { class: 'stats-tiles' },
      tile('끝낸 일 (체크한 날 기준)', String(doneTotal), `할 일 ${todosDone} · 일정 ${eventsDone}`,
        '이 기간에 체크해서 끝낸 할 일과 일정의 개수예요.'),
      tile('기한 달성률', rate === null ? '-' : `${rate}%`, dueTotal ? `기한이 된 ${dueTotal}개 중 ${dueDone}개 처리` : '기한이 된 항목이 아직 없어요',
        '기한(일정은 날짜)이 이 기간 안에 있고 이미 지난 항목 중, 처리한 비율이에요.'),
      tile('연속 달성', `${streak}일`, streak ? '하루 1개 이상 끝낸 날이 계속' : '오늘 하나 끝내 보세요'),
      tile('일정 시간', hourTotal ? hoursText(hourTotal) : '0시간', '예정된 일정 포함'));
    const basisNote = h('p', { class: 'muted stat-note stat-basis' },
      '끝낸 일은 "체크한 날", 기한 달성률은 "기한이 이 기간인 항목" 기준이라 서로 다를 수 있어요. ' +
      '체크한 시각이 기록되지 않은 예전 항목은 끝낸 일에는 빠지고 달성률에는 들어가요.');

    // 일별 완료 막대
    const chartCard = h('div', { class: 'card stat-wide' },
      h('div', { class: 'card-head' },
        h('h2', { text: '일별 완료한 일' }),
        h('span', { class: 'muted', text: `${days[0].getMonth() + 1}/${days[0].getDate()} – ${days[days.length - 1].getMonth() + 1}/${days[days.length - 1].getDate()}` })),
      doneTotal
        ? dailyChart(days, log.at, todayKey, state.statRange === 'week' ? 'week' : 'range')
        : h('div', { class: 'empty-inline', text: '이 기간에 완료한 기록이 없어요. 할 일이나 일정을 체크하면 여기에 쌓여요.' }),
      h('details', { class: 'stat-table' },
        h('summary', { text: '표로 보기' }),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', { text: '날짜' }), h('th', { text: '할 일' }), h('th', { text: '일정' }), h('th', { text: '합계' }))),
          h('tbody', {}, days.filter((d) => log.at(fmtDate(d))).map((d) => {
            const k = fmtDate(d);
            return h('tr', {}, h('td', { text: `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})` }), h('td', { text: String(log.todos[k] || 0) }), h('td', { text: String(log.events[k] || 0) }), h('td', { text: String(log.at(k)) }));
          })))),
      h('p', { class: 'muted stat-note', text: '완료 기록은 체크한 시점부터 쌓여요. 카테고리 필터와 상관없이 전체를 집계해요.' }));

    // 카테고리별 시간
    const hoursCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: '카테고리별 일정 시간' }), h('span', { class: 'muted', text: hourTotal ? `합계 ${hoursText(hourTotal)}` : '' })),
      hourRows.length ? hourRows.map(([k, v]) => {
        const cat = k === NONE ? null : catById(k);
        const row = h('div', { class: 'hbar-row', title: `${cat ? catName(cat) : '미분류'}: ${hoursText(v)}` },
          h('span', { class: 'hbar-name', text: cat ? catName(cat) : '미분류' }),
          h('span', { class: 'hbar' }, h('i', { style: { width: `${Math.max(3, (v / hourMax) * 100)}%` } })),
          h('span', { class: 'hbar-val', text: hoursText(v) }));
        row.style.setProperty('--c', cat ? cat.color : UNCAT_COLOR);
        return row;
      }) : h('div', { class: 'empty-inline', text: '이 기간에 시간이 정해진 일정이 없어요.' }));

    // 목표 진행
    const goals = data.projects.filter((p) => p.status !== 'done')
      .sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : 1));
    const goalCard = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: '목표 진행' }), h('button', { type: 'button', class: 'link-btn', onclick: () => goPage('goals') }, '목표 보기')),
      goals.length ? goals.slice(0, 6).map((p) => {
        const st = projectStats(p);
        const dd = ddayInfo(p.due, false);
        const row = h('div', { class: 'hbar-row', title: `${p.title}: ${st.pct}%` },
          h('span', { class: 'hbar-name', text: p.title }),
          h('span', { class: 'hbar' }, h('i', { style: { width: `${Math.max(st.pct ? 3 : 0, st.pct)}%` } })),
          h('span', { class: 'hbar-val', text: `${st.pct}%${dd ? ' · ' + dd.text : ''}` }));
        row.style.setProperty('--c', catById(p.categoryId)?.color || 'var(--accent)');
        return row;
      }) : h('div', { class: 'empty-inline', text: '진행 중인 목표가 없어요.' }));

    root.append(h('div', { class: 'stats' }, tiles, basisNote, chartCard, h('div', { class: 'stats-cols' }, hoursCard, goalCard)));
  }

  // ---------- 페이지 ----------
  const PAGES = ['home', 'calendar', 'todos', 'goals', 'stats', 'settings'];

  function goPage(name) {
    state.page = name;
    closeSideMenu();
    render();
  }
  // 좁은 화면: ☰로 여는 검색·카테고리 영역
  function closeSideMenu() {
    const sb = $('#sidebar');
    if (!sb) return;
    sb.classList.remove('open');
    const t = $('#sideToggle');
    if (t) { t.setAttribute('aria-expanded', 'false'); t.setAttribute('aria-label', '검색·카테고리 열기'); }
  }

  function render() {
    renderSidebar();
    PAGES.forEach((p) => { $(`#page-${p}`).hidden = state.page !== p; });
    renderQuickSelects();
    if (state.page === 'home') renderHome();
    else if (state.page === 'calendar') renderCalendar();
    else if (state.page === 'todos') renderTodos();
    else if (state.page === 'goals') renderProjects();
    else if (state.page === 'stats') renderStats();
    else if (state.page === 'settings') renderSettings();
  }

  // ---------- 탐색 ----------
  function setView(v) {
    state.view = v;
    data.settings.defaultView = v;
    save();
    render();
  }

  function navigate(dir) {
    const c = state.cursor;
    if (state.view === 'month') {
      const first = new Date(c.getFullYear(), c.getMonth() + dir, 1);
      state.cursor = new Date(first.getFullYear(), first.getMonth(), Math.min(c.getDate(), daysInMonth(first.getFullYear(), first.getMonth())));
    } else if (state.view === 'week') state.cursor = addDays(c, 7 * dir);
    else state.cursor = addDays(c, dir);
    render();
  }

  // ---------- 일정 대화상자 ----------
  const evDlg = $('#eventDialog');
  let editing = { ev: null, occDate: null };
  let selectedColor = COLORS[0];
  const UNIT = { daily: '일', weekly: '주', monthly: '개월', yearly: '년' };

  function buildSwatches() {
    const box = $('#ev-colors');
    box.replaceChildren();
    for (const c of COLORS) {
      const b = h('button', { type: 'button', class: 'swatch', 'aria-label': c, 'aria-pressed': 'false' });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => { selectedColor = c; paintSwatches(); });
      b.dataset.color = c;
      box.append(b);
    }
  }
  function paintSwatches() {
    document.querySelectorAll('#ev-colors .swatch').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.color === selectedColor));
    });
  }

  function syncEventForm() {
    const allDay = $('#ev-allday').checked;
    $('#ev-start-time').hidden = allDay;
    $('#ev-end-time').hidden = allDay;
    const rep = $('#ev-repeat').value;
    const repeating = rep !== 'none';
    $('#ev-repeat-extra').hidden = !repeating;
    $('#ev-interval-unit').textContent = UNIT[rep] || '일';

    // 반복 일정은 끝나는 날짜 대신 "반복 종료일"을 쓰므로 종료 날짜는 시작일과 같게 고정
    if (repeating) $('#ev-end-date').value = $('#ev-start-date').value;
    $('#ev-end-date').hidden = repeating;
    $('#ev-end-row').hidden = allDay && repeating;

    // 카테고리를 고르면 그 카테고리 색을 쓰므로 색상 선택은 미분류일 때만 보여줌
    $('#ev-color-row').hidden = !!$('#ev-cat').value;
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = !msg;
  }

  function openEventDialog(ev, opts = {}) {
    editing = { ev, occDate: opts.occDate || null };
    let sd, st, ed, et, allDay;
    if (ev) {
      allDay = !!ev.allDay;
      sd = ev.start.slice(0, 10);
      st = allDay ? '09:00' : ev.start.slice(11, 16);
      ed = (ev.end || ev.start).slice(0, 10);
      et = allDay ? '10:00' : (ev.end ? ev.end.slice(11, 16) : st);
    } else {
      let s;
      if (opts.start) s = opts.start;
      else if (opts.date) s = new Date(opts.date.getFullYear(), opts.date.getMonth(), opts.date.getDate(), 9, 0);
      else { s = new Date(); s = new Date(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours() + 1, 0); }
      const e = new Date(s.getTime() + 3600e3);
      allDay = !!opts.allDay;
      sd = fmtDate(s); st = hhmm(s);
      ed = allDay ? sd : fmtDate(e); et = hhmm(e);
    }

    $('#eventDialogTitle').textContent = ev ? '일정 편집' : '새 일정';
    const canCheck = !!ev && !!opts.occDate;
    $('#ev-done-row').hidden = !canCheck;
    $('#ev-done').checked = canCheck && isDoneOn(ev, opts.occDate);
    $('#ev-done-date').textContent = canCheck ? `(${shortDate(opts.occDate)})` : '';
    $('#ev-title').value = ev?.title || '';
    $('#ev-allday').checked = allDay;
    $('#ev-start-date').value = sd;
    $('#ev-start-time').value = st;
    $('#ev-end-date').value = ed;
    $('#ev-end-time').value = et;
    $('#ev-repeat').value = ev?.repeat || 'none';
    $('#ev-interval').value = ev?.repeatInterval || 1;
    $('#ev-until').value = ev?.repeatUntil || '';
    $('#ev-reminder').value = ev?.reminder == null ? '' : String(ev.reminder);
    $('#ev-memo').value = ev?.memo || '';
    selectedColor = ev?.color || COLORS[0];
    paintSwatches();

    fillSelect($('#ev-cat'), catOptions('미분류'));
    $('#ev-cat').value = ev ? (catById(ev.categoryId) ? ev.categoryId : '') : defaultCatForNew();
    syncEventForm();

    const repeating = !!ev && ev.repeat && ev.repeat !== 'none';
    const note = $('#ev-note');
    note.hidden = !repeating;
    note.textContent = repeating ? '반복 일정이라 저장하면 모든 회차에 변경이 적용돼요.' : '';
    $('#ev-delete-one').hidden = !(repeating && editing.occDate);
    $('#ev-delete-all').hidden = !ev;
    $('#ev-delete-all').textContent = repeating ? '전체 삭제' : '삭제';
    showError('#ev-error', '');

    evDlg.showModal();
    $('#ev-title').focus();
  }

  function saveEvent() {
    const allDay = $('#ev-allday').checked;
    const sd = $('#ev-start-date').value;
    // 반복 일정은 하루짜리 일정으로 저장 (끝나는 날짜는 "반복 종료일"이 정함)
    const ed = $('#ev-repeat').value !== 'none' ? sd : ($('#ev-end-date').value || sd);
    if (!sd) return showError('#ev-error', '시작 날짜를 입력해 주세요.');

    let start, end;
    if (allDay) {
      start = sd;
      end = ed < sd ? sd : ed;
    } else {
      const st = $('#ev-start-time').value || '09:00';
      const et = $('#ev-end-time').value || st;
      start = `${sd}T${st}`;
      end = `${ed}T${et}`;
      if (end < start) {
        return showError('#ev-error', $('#ev-repeat').value !== 'none'
          ? '종료 시간이 시작 시간보다 빨라요. 반복 일정은 하루 안에서 끝나야 해요.'
          : '종료 시각이 시작 시각보다 빠를 수 없어요.');
      }
    }

    const repeat = $('#ev-repeat').value;

    // 일정 하나의 길이가 반복 간격보다 길면 회차끼리 겹쳐서 달력이 가득 차 버립니다.
    if (repeat !== 'none') {
      const dur = parseLocal(end) - parseLocal(start) + (allDay ? DAY_MS : 0);
      const gap = Math.max(1, parseInt($('#ev-interval').value, 10) || 1);
      const periodMs = { daily: 1, weekly: 7, monthly: 28, yearly: 365 }[repeat] * DAY_MS * gap;
      if (dur > periodMs + 2 * 3600e3) {
        return showError('#ev-error',
          '일정 하나가 반복 간격보다 길어서 회차끼리 겹쳐요. "종료"는 일정 하나가 끝나는 시각이에요. 반복을 끝낼 날짜는 아래 "반복 종료일"에 입력해 주세요.');
      }
    }

    const until = repeat === 'none' ? null : ($('#ev-until').value || null);
    if (until && until < sd) return showError('#ev-error', '반복 종료일이 시작 날짜보다 빠를 수 없어요.');

    const rem = $('#ev-reminder').value;
    const obj = {
      id: editing.ev?.id || uid(),
      title: $('#ev-title').value.trim(),
      memo: $('#ev-memo').value,
      color: selectedColor,
      categoryId: $('#ev-cat').value || null,
      allDay,
      start,
      end,
      repeat,
      repeatInterval: Math.max(1, parseInt($('#ev-interval').value, 10) || 1),
      repeatUntil: until,
      exceptions: editing.ev?.exceptions || [],
      doneOn: { ...(editing.ev?.doneOn || {}) },
      reminder: rem === '' ? null : Number(rem),
    };

    if (!$('#ev-done-row').hidden && editing.occDate && $('#ev-done').checked !== isDoneOn(obj, editing.occDate)) {
      setOccDone(obj, editing.occDate, $('#ev-done').checked);
    }

    // 비반복 일정의 날짜를 편집해 옮겨도 완료 표시를 새 날짜로 옮깁니다.
    if (editing.ev && !isRepeating(editing.ev) && repeat === 'none') {
      const oldKey = editing.ev.start.slice(0, 10);
      const newKey = start.slice(0, 10);
      if (oldKey !== newKey && obj.doneOn[oldKey]) {
        obj.doneOn[newKey] = obj.doneOn[oldKey];
        delete obj.doneOn[oldKey];
      }
    }

    const i = data.events.findIndex((e) => e.id === obj.id);
    if (i >= 0) data.events[i] = obj;
    else data.events.push(obj);
    save();
    evDlg.close();
    render();
  }

  function deleteEvent(onlyThisOccurrence) {
    const ev = editing.ev;
    if (!ev) return;
    const snap = takeSnapshot();
    const title = ev.title || '일정';
    if (onlyThisOccurrence && editing.occDate) {
      ev.exceptions = [...(ev.exceptions || []), editing.occDate];
    } else {
      data.events = data.events.filter((e) => e.id !== ev.id);
    }
    save();
    evDlg.close();
    render();
    offerUndo(`"${title}" 일정을 지웠어요.`, snap);
  }

  // ---------- 할 일 대화상자 ----------
  const tdDlg = $('#todoDialog');
  let editingTodo = null;

  function openTodoDialog(t) {
    editingTodo = t;
    $('#td-title').value = t.title;
    $('#td-due').value = t.due || '';
    $('#td-prio').value = String(t.priority ?? 1);
    $('#td-done').checked = !!t.done;
    $('#td-memo').value = t.memo || '';
    fillSelect($('#td-cat'), catOptions('미분류'));
    $('#td-cat').value = catById(t.categoryId) ? t.categoryId : '';
    fillSelect($('#td-proj'), projOptions('목표 없음', false));
    $('#td-proj').value = projById(t.projectId) ? t.projectId : '';
    showError('#td-error', '');
    tdDlg.showModal();
    $('#td-title').focus();
  }

  function saveTodo() {
    const title = $('#td-title').value.trim();
    if (!title) return showError('#td-error', '할 일 제목을 입력해 주세요.');
    Object.assign(editingTodo, {
      title,
      due: $('#td-due').value || null,
      priority: Number($('#td-prio').value),
      memo: $('#td-memo').value,
      categoryId: $('#td-cat').value || null,
      projectId: $('#td-proj').value || null,
    });
    if (!!editingTodo.done !== $('#td-done').checked) setTodoDone(editingTodo, $('#td-done').checked);
    save();
    tdDlg.close();
    render();
  }

  // ---------- 목표 대화상자 ----------
  const pjDlg = $('#projDialog');
  let editingProj = null;

  function openProjectDialog(p) {
    editingProj = p;
    $('#pj-title').value = p.title;
    $('#pj-due').value = p.due || '';
    fillSelect($('#pj-cat'), catOptions('미분류'));
    $('#pj-cat').value = catById(p.categoryId) ? p.categoryId : '';
    $('#pj-status').value = p.status === 'done' ? 'done' : 'active';
    $('#pj-memo').value = p.memo || '';
    const st = projectStats(p);
    $('#pj-note').textContent = st.total
      ? `연결된 할 일 ${st.total}개 중 ${st.done}개 완료. 삭제해도 할 일은 남고 목표 연결만 해제돼요.`
      : '연결된 할 일이 아직 없어요. 삭제해도 할 일은 지워지지 않아요.';
    showError('#pj-error', '');
    pjDlg.showModal();
    $('#pj-title').focus();
  }

  function saveProject() {
    const title = $('#pj-title').value.trim();
    if (!title) return showError('#pj-error', '이름을 입력해 주세요.');
    Object.assign(editingProj, {
      title,
      due: $('#pj-due').value || null,
      categoryId: $('#pj-cat').value || null,
      memo: $('#pj-memo').value,
    });
    const nextStatus = $('#pj-status').value;
    if ((editingProj.status === 'done') !== (nextStatus === 'done')) setProjectStatus(editingProj, nextStatus);
    save();
    pjDlg.close();
    render();
  }

  function deleteProject() {
    const id = editingProj.id;
    const snap = takeSnapshot();
    const title = editingProj.title || '목표';
    data.todos.forEach((t) => { if (t.projectId === id) t.projectId = null; });
    data.projects = data.projects.filter((p) => p.id !== id);
    state.expanded.delete(id);
    save();
    pjDlg.close();
    render();
    offerUndo(`"${title}" 목표를 지웠어요.`, snap);
  }

  // ---------- 카테고리 편집 대화상자 ----------
  const catDlg = $('#catDialog');
  let editingCatId = null;
  // 새 카테고리는 추가를 확정하기 전까지 저장 자료에 넣지 않습니다.
  let draftCategory = null;
  const editingCategory = () => draftCategory || catById(editingCatId);

  function paintCatSwatches() {
    const c = editingCategory();
    document.querySelectorAll('#cat-colors .swatch').forEach((b) => {
      b.setAttribute('aria-pressed', String(!!c && b.dataset.color === String(c.color).toLowerCase()));
    });
    if (c) $('#cat-color').value = c.color;
  }

  function setCatColor(color) {
    const c = editingCategory();
    if (!c) return;
    c.color = color;
    paintCatSwatches();
    if (!draftCategory) { save(); render(); }
  }

  function openCatEdit(id, isNew) {
    const c = isNew ? draftCategory : catById(id);
    if (!c) return;
    if (!isNew) draftCategory = null;
    editingCatId = id;
    $('#catDlgTitle').textContent = isNew ? '새 카테고리' : '카테고리 편집';
    $('#cat-name').value = c.name;
    $('#cat-name').setCustomValidity('');
    $('#cat-delete').hidden = !!isNew;
    $('#cat-cancel').hidden = !isNew;
    $('#cat-done').textContent = isNew ? '추가' : '완료';
    $('#cat-note').textContent = isNew
      ? '추가를 눌러야 저장돼요. 취소하거나 Esc로 닫으면 카테고리가 생기지 않아요.'
      : '이름과 색은 바로 적용돼요. 삭제하면 이 카테고리의 일정·할 일·목표는 미분류로 바뀌고, 일정은 기존 색을 그대로 유지해요.';
    paintCatSwatches();
    catDlg.showModal();
    $('#cat-name').focus();
    $('#cat-name').select();
  }

  function newCategory() {
    // 이미 쓰는 색은 피해서, 안 쓴 색부터 골라 줍니다.
    const used = new Set(data.categories.map((c) => String(c.color).toLowerCase()));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[data.categories.length % COLORS.length];
    draftCategory = { id: uid(), name: '새 카테고리', color };
    openCatEdit(draftCategory.id, true);
  }

  function deleteCategory(id) {
    const c = catById(id);
    const snap = takeSnapshot();
    data.events.forEach((ev) => {
      if (ev.categoryId === id) { ev.color = c ? c.color : ev.color; ev.categoryId = null; }
    });
    data.todos.forEach((t) => { if (t.categoryId === id) t.categoryId = null; });
    data.projects.forEach((p) => { if (p.categoryId === id) p.categoryId = null; });
    data.categories = data.categories.filter((x) => x.id !== id);
    state.hidden.delete(id);
    persistFilter();
    catDlg.close();
    render();
    offerUndo(`"${c ? catName(c) : '카테고리'}" 카테고리를 지웠어요.`, snap);
  }

  // ---------- 이벤트 연결 ----------
  function bind() {
    buildDatePicker();
    $('#prev').addEventListener('click', () => navigate(-1));
    $('#next').addEventListener('click', () => navigate(1));
    $('#today').addEventListener('click', () => { state.cursor = new Date(); render(); });
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    document.querySelectorAll('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => { state.todoFilter = b.dataset.filter; renderTodos(); }));
    document.querySelectorAll('[data-pfilter]').forEach((b) =>
      b.addEventListener('click', () => { state.projFilter = b.dataset.pfilter; renderProjects(); }));
    document.querySelectorAll('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => { if (!b.disabled) goPage(b.dataset.nav); }));
    $('#newEvent').addEventListener('click', () => openEventDialog(null, {}));

    // 설정 페이지
    $('#set-weekStart').addEventListener('change', (e) => {
      data.settings.weekStart = Number(e.target.value);
      save();
      render();
    });
    // 빠른 추가
    $('#quickOpen').addEventListener('click', openQuickDialog);
    $('#sideToggle').addEventListener('click', () => {
      const open = $('#sidebar').classList.toggle('open');
      $('#sideToggle').setAttribute('aria-expanded', String(open));
      $('#sideToggle').setAttribute('aria-label', open ? '검색·카테고리 닫기' : '검색·카테고리 열기');
    });
    // 화면 폭이 좁은/넓은 쪽으로 바뀌면(휴대폰 가로 회전, 창 크기 조절) 달력 구성을 다시 그려요.
    if (narrowMQ.addEventListener) narrowMQ.addEventListener('change', () => { closeSideMenu(); render(); });
    $('#quickInput').addEventListener('input', renderQuickPreview);
    document.querySelectorAll('[data-qkind]').forEach((b) => b.addEventListener('click', () => { state.quickKind = b.dataset.qkind; renderQuickPreview(); $('#quickInput').focus(); }));
    $('#quickForm').addEventListener('submit', (e) => { e.preventDefault(); submitQuick(); });
    $('#quickCancel').addEventListener('click', () => quickDlg.close());
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickDialog(); }
    });
    document.querySelectorAll('[data-stat]').forEach((b) => b.addEventListener('click', () => { state.statRange = b.dataset.stat; renderStats(); }));
    $('#set-holidays').addEventListener('change', (e) => {
      data.settings.holidays = e.target.checked;
      save();
      render();
    });
    $('#set-notify').addEventListener('change', (e) => {
      data.settings.notifications = e.target.checked;
      save();
    });
    $('#set-catNew').addEventListener('click', newCategory);
    $('#set-keep').addEventListener('change', (e) => { data.settings.keepRunning = e.target.checked; save(); });
    $('#set-autostart').addEventListener('change', (e) => { data.settings.autoStart = e.target.checked; save(); });
    const N = () => window.PlannerNative;
    // OS/파일 작업이 실패하면 화면에 안내하고 버튼을 다시 사용할 수 있게 합니다.
    const nativeAction = async (button, messageId, action, failure) => {
      if (!N() || button.disabled) return;
      button.disabled = true;
      try { await action(); }
      catch {
        const msg = $(messageId);
        msg.textContent = failure;
        msg.className = 'set-msg err';
      } finally { button.disabled = false; }
    };
    $('#set-folderOpen').addEventListener('click', (e) => nativeAction(e.currentTarget, '#set-folderMsg', async () => {
      if (await N().openFolder()) throw new Error('Open folder failed');
    }, '저장 폴더를 열지 못했어요. 폴더가 있는지 확인한 뒤 다시 시도해 주세요.'));
    $('#set-backupOpen').addEventListener('click', (e) => nativeAction(e.currentTarget, '#set-backupMsg', async () => {
      if (await N().openBackupFolder()) throw new Error('Open backup folder failed');
    }, '백업 폴더를 열지 못했어요. 폴더 권한을 확인한 뒤 다시 시도해 주세요.'));
    $('#set-backupNow').addEventListener('click', (e) => nativeAction(e.currentTarget, '#set-backupMsg', async () => {
      renderBackupList(await N().backupNow());
      $('#set-backupMsg').textContent = '지금 상태를 백업했어요.';
      $('#set-backupMsg').className = 'set-msg ok';
    }, '백업하지 못했어요. 저장 상태와 폴더 권한을 확인한 뒤 다시 시도해 주세요.'));
    const folderResult = (r, okText) => {
      const msg = $('#set-folderMsg');
      if (!r || r.canceled || r.same) { msg.textContent = ''; return; }
      if (r.error) { msg.textContent = r.error; msg.className = 'set-msg err'; return; }
      if (r.data) { applyLoaded(r.data); save(); render(); }
      msg.textContent = okText;
      msg.className = 'set-msg ok';
    };
    $('#set-folder').addEventListener('click', (e) => nativeAction(e.currentTarget, '#set-folderMsg', async () => folderResult(await N().chooseFolder(), '저장 위치를 바꿨어요. 이 PC의 예전 데이터는 자동 백업에 남아 있어요.'), '저장 위치를 바꾸지 못했어요. 저장 상태와 폴더 권한을 확인한 뒤 다시 시도해 주세요.'));
    $('#set-folderReset').addEventListener('click', (e) => nativeAction(e.currentTarget, '#set-folderMsg', async () => folderResult(await N().resetFolder(), '기본 위치로 되돌렸어요.'), '기본 위치로 바꾸지 못했어요. 저장 상태와 폴더 권한을 확인한 뒤 다시 시도해 주세요.'));
    // 다른 PC(동기화 폴더)에서 데이터가 바뀌면 불러옵니다.
    if (window.PlannerNative) {
      window.PlannerNative.onExternalChange((d) => {
        applyLoaded(d);
        render();
        state.undoSnap = null;
        toast('다른 PC에서 바뀐 내용을 불러왔어요.');
      });
    }
    $('#set-export').addEventListener('click', downloadBackup);
    $('#set-copy').addEventListener('click', copyBackup);
    $('#set-import').addEventListener('click', importBackup);
    $('#set-undo').addEventListener('click', undoImport);
    $('#set-importBox').addEventListener('input', () => { resetImportBtn(); setMsg(''); });
    $('#set-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { $('#set-importBox').value = await f.text(); }
      catch { setMsg('파일을 읽지 못했어요. 파일을 다시 선택해 주세요.', 'err'); return; }
      resetImportBtn();
      const r = parseBackup($('#set-importBox').value);
      setMsg(r.error || `${f.name}: ${summaryOf(r.obj)} — "가져오기"를 누르세요.`, r.error ? 'err' : '');
    });

    // 검색 / 필터 해제
    $('#searchBox').addEventListener('input', (e) => { state.q = e.target.value; render(); });
    $('#fclear').addEventListener('click', () => {
      state.hidden = new Set();
      state.q = '';
      $('#searchBox').value = '';
      persistFilter();
      render();
    });

    // 카테고리 편집 대화상자
    const swatchBox = $('#cat-colors');
    COLORS.forEach((color) => {
      const b = h('button', { type: 'button', class: 'swatch', 'aria-label': color, 'aria-pressed': 'false' });
      b.style.setProperty('--c', color);
      b.dataset.color = color;
      b.addEventListener('click', () => setCatColor(color));
      swatchBox.append(b);
    });
    $('#cat-color').addEventListener('input', (e) => setCatColor(e.target.value));
    $('#cat-name').addEventListener('input', (e) => {
      e.target.setCustomValidity('');
      const c = editingCategory();
      if (c) {
        c.name = e.target.value;
        if (!draftCategory) { save(); render(); }
      }
    });
    $('#cat-delete').addEventListener('click', () => deleteCategory(editingCatId));
    $('#cat-cancel').addEventListener('click', () => catDlg.close());
    catDlg.addEventListener('close', () => { draftCategory = null; editingCatId = null; });
    $('#catForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (draftCategory) {
        const name = $('#cat-name').value.trim();
        if (!name) {
          $('#cat-name').setCustomValidity('카테고리 이름을 입력해 주세요.');
          $('#cat-name').reportValidity();
          return;
        }
        data.categories.push({ ...draftCategory, name });
        draftCategory = null;
        save();
        render();
      }
      catDlg.close();
    });
    $('#catNew').addEventListener('click', newCategory);

    // 일정 대화상자
    buildSwatches();
    $('#ev-allday').addEventListener('change', syncEventForm);
    $('#ev-repeat').addEventListener('change', syncEventForm);
    $('#ev-cat').addEventListener('change', syncEventForm);
    $('#ev-start-date').addEventListener('change', () => {
      const repeating = $('#ev-repeat').value !== 'none';
      if (repeating || $('#ev-end-date').value < $('#ev-start-date').value) $('#ev-end-date').value = $('#ev-start-date').value;
    });
    $('#eventForm').addEventListener('submit', (e) => { e.preventDefault(); saveEvent(); });
    $('#ev-cancel').addEventListener('click', () => evDlg.close());
    $('#ev-delete-one').addEventListener('click', () => deleteEvent(true));
    $('#ev-delete-all').addEventListener('click', () => deleteEvent(false));

    // 할 일 대화상자
    $('#todoForm').addEventListener('submit', (e) => { e.preventDefault(); saveTodo(); });
    $('#td-cancel').addEventListener('click', () => tdDlg.close());
    $('#td-delete').addEventListener('click', () => {
      const snap = takeSnapshot();
      const title = editingTodo.title || '할 일';
      data.todos = data.todos.filter((t) => t !== editingTodo);
      save();
      tdDlg.close();
      render();
      offerUndo(`"${title}" 할 일을 지웠어요.`, snap);
    });

    // 목표 대화상자
    $('#projForm').addEventListener('submit', (e) => { e.preventDefault(); saveProject(); });
    $('#pj-cancel').addEventListener('click', () => pjDlg.close());
    $('#pj-delete').addEventListener('click', deleteProject);

    // 할 일 빠른 추가
    for (const [inputId, errorId] of [['todoNew', 'todoAddError'], ['projNew', 'projAddError']]) {
      $('#' + inputId).addEventListener('input', () => {
        $('#' + inputId).removeAttribute('aria-invalid');
        $('#' + errorId).hidden = true;
      });
    }
    function addTitle(inputId, errorId) {
      const input = $('#' + inputId);
      const title = input.value.trim();
      $('#' + errorId).hidden = !!title;
      if (!title) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      } else input.removeAttribute('aria-invalid');
      return title;
    }
    $('#todoAdd').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#todoNew');
      const title = addTitle('todoNew', 'todoAddError');
      if (!title) return;
      data.todos.push({
        id: uid(),
        title,
        done: false,
        due: $('#todoNewDue').value || null,
        priority: Number($('#todoNewPrio').value),
        memo: '',
        categoryId: $('#todoNewCat').value || null,
        projectId: $('#todoNewProj').value || null,
        createdAt: Date.now(),
      });
      input.value = '';
      $('#todoNewDue').value = '';
      save();
      render();
      input.focus();
    });

    // 목표 빠른 추가
    $('#projAdd').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#projNew');
      const title = addTitle('projNew', 'projAddError');
      if (!title) return;
      data.projects.push({
        id: uid(),
        title,
        due: $('#projNewDue').value || null,
        categoryId: $('#projNewCat').value || null,
        status: 'active',
        memo: '',
        createdAt: Date.now(),
      });
      input.value = '';
      $('#projNewDue').value = '';
      save();
      render();
      input.focus();
    });

    // 단축키: ← → 이동, t 오늘, m/w/d 보기, n 새 일정, / 검색
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && state.undoSnap
        && !e.target.closest('input, textarea') && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        undoDelete();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
      const cal = state.page === 'calendar';
      const keys = {
        ...(cal ? {
          ArrowLeft: () => navigate(-1),
          ArrowRight: () => navigate(1),
          t: () => { state.cursor = new Date(); render(); },
          m: () => setView('month'),
          w: () => setView('week'),
          d: () => setView('day'),
        } : {}),
        n: () => openEventDialog(null, {}),
        q: openQuickDialog,
        '/': () => $('#searchBox').focus(),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    });

    // 1분마다 새로 그려 현재 시각 선/오늘 표시/남은 일정을 갱신
    setInterval(() => {
      if (state.page === 'calendar') renderCalendar();
      else if (state.page === 'home' && !document.querySelector('dialog[open]') && !(document.activeElement && document.activeElement.id === 'homeQuick' && document.activeElement.value)) renderHome();
    }, 60 * 1000);
  }

  // ---------- 시작 ----------
  // ---------- 데이터 검사 ----------
  // 불러온 내용에 깨진 항목(빈 값, 잘못된 날짜 등)이 있어도 앱이 멈추지 않도록 정리합니다.
  // 고칠 수 없는 항목은 빼고, 몇 개를 뺐는지 돌려줘요.
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  // 2026-13-45 처럼 달력에 없는 날짜는 거릅니다. (Date가 자동으로 넘겨 계산하는 값이므로 되돌려 비교)
  const okDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fmtDate(parseLocal(v)) === v;
  const okDateTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/.test(v) && okDate(v.slice(0, 10));
  const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

  function sanitizeData(src) {
    const list = (v) => (Array.isArray(v) ? v : []);
    let dropped = 0;
    const keep = (arr, fix) => list(arr).map((x) => (isObj(x) ? fix(x) : null)).filter((x) => { if (!x) dropped++; return !!x; });

    const categories = keep(src.categories, (c) => (typeof c.name === 'string'
      ? { ...c, id: strOrNull(c.id) || uid(), color: /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : COLORS[0] } : null));
    const events = keep(src.events, (e) => {
      if (!okDateTime(e.start)) return null;
      return {
        ...e,
        id: strOrNull(e.id) || uid(),
        title: typeof e.title === 'string' ? e.title : '',
        memo: typeof e.memo === 'string' ? e.memo : '',
        allDay: !!e.allDay && e.start.length === 10,
        end: okDateTime(e.end) && e.end.length === e.start.length ? e.end : e.start,
        categoryId: strOrNull(e.categoryId),
        repeat: ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(e.repeat) ? e.repeat : 'none',
        repeatInterval: Math.max(1, parseInt(e.repeatInterval, 10) || 1),
        repeatUntil: okDate(e.repeatUntil) ? e.repeatUntil : null,
        exceptions: list(e.exceptions).filter(okDate),
        doneOn: isObj(e.doneOn) ? Object.fromEntries(Object.entries(e.doneOn).filter(([key, value]) => okDate(key) && (value === true || (typeof value === 'number' && Number.isFinite(value) && value > 0)))) : {},
        reminder: typeof e.reminder === 'number' && e.reminder >= 0 ? e.reminder : null,
      };
    });
    const todos = keep(src.todos, (t) => ({
      ...t,
      id: strOrNull(t.id) || uid(),
      title: typeof t.title === 'string' ? t.title : '',
      memo: typeof t.memo === 'string' ? t.memo : '',
      done: !!t.done,
      due: okDate(t.due) ? t.due : null,
      priority: [0, 1, 2].includes(t.priority) ? t.priority : 1,
      categoryId: strOrNull(t.categoryId),
      projectId: strOrNull(t.projectId),
    }));
    const projects = keep(src.projects, (p) => ({
      ...p,
      id: strOrNull(p.id) || uid(),
      title: typeof p.title === 'string' ? p.title : '',
      memo: typeof p.memo === 'string' ? p.memo : '',
      status: p.status === 'done' ? 'done' : 'active',
      due: okDate(p.due) ? p.due : null,
      categoryId: strOrNull(p.categoryId),
    }));
    return { events, todos, projects, categories: Array.isArray(src.categories) ? categories : null, dropped };
  }

  // 저장된(또는 가져온) 내용을 앱 데이터로 정리해서 적용합니다. 빠진 항목은 기본값으로 채워요.
  function applyLoaded(loaded) {
    const clean = sanitizeData(isObj(loaded) ? loaded : {});
    state.lastDropped = clean.dropped;
    const cats = clean.categories || DEFAULT_CATS();
    data = {
      events: clean.events,
      todos: clean.todos,
      projects: clean.projects,
      categories: cats,
      settings: isObj(loaded && loaded.settings) ? { ...loaded.settings } : {},
    };
    // 일정 완료 체크는 처음 켠 날부터 셉니다. (그 전의 지난 일정이 한꺼번에 밀린 일로 뜨지 않도록)
    if (!okDate(data.settings.taskTrackingSince)) data.settings.taskTrackingSince = fmtDate(new Date());
    data.settings.weekStart = weekStart();
    const valid = new Set([NONE, ...cats.map((c) => c.id)]);
    state.hidden = new Set((Array.isArray(data.settings.hiddenCategories) ? data.settings.hiddenCategories : []).filter((k) => valid.has(k)));
    data.settings.hiddenCategories = [...state.hidden];
    if (['month', 'week', 'day'].includes(data.settings.defaultView)) state.view = data.settings.defaultView;
  }

  // ---------- 설정 / 백업 ----------
  const EXPORT_KEYS = ['events', 'todos', 'projects', 'categories', 'settings'];
  const exportJson = () => JSON.stringify({
    app: '내 플래너',
    exportedAt: new Date().toISOString(),
    ...Object.fromEntries(EXPORT_KEYS.map((k) => [k, data[k]])),
  }, null, 2);
  const summaryOf = (d) =>
    `일정 ${(d.events || []).length}개 · 할 일 ${(d.todos || []).length}개 · 목표 ${(d.projects || []).length}개 · 카테고리 ${(d.categories || []).length}개`;

  // 붙여넣은 글이 내 플래너 백업인지 확인합니다. 맞으면 { obj }, 아니면 { error }.
  function parseBackup(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return { error: '백업 내용을 읽을 수 없어요. 파일을 그대로 붙여넣었는지 확인해 주세요.' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !['events', 'todos', 'projects'].some((k) => Array.isArray(obj[k]))) {
      return { error: '내 플래너 백업 파일이 아니에요.' };
    }
    return { obj };
  }

  const setMsg = (text, kind) => {
    const el = $('#set-importMsg');
    el.textContent = text || '';
    el.className = 'set-msg' + (kind ? ' ' + kind : '');
  };

  async function loadAppVersion() {
    const label = $('#app-version');
    if (!window.plannerApp?.getVersion) {
      label.textContent = '브라우저 미리보기';
      return;
    }
    try {
      const version = await window.plannerApp.getVersion();
      if (typeof version !== 'string' || !version.trim()) throw new Error('Missing app version');
      label.textContent = 'v' + version;
      document.title = '내 플래너 v' + version;
    } catch {
      label.textContent = '버전 정보를 불러오지 못했어요.';
    }
  }

  function loadUpdates() {
    const api = window.plannerApp?.updates;
    const status = $('#update-status');
    const check = $('#update-check');
    const install = $('#update-install');
    if (!api) { status.textContent = '브라우저 미리보기에서는 업데이트할 수 없어요.'; return; }
    let revision = -1;
    function show(next) {
      if (next.revision < revision) return;
      revision = next.revision;
      check.disabled = ['unsupported', 'checking', 'downloading', 'ready', 'preparing', 'installing', 'restart-required'].includes(next.status);
      install.hidden = next.status !== 'ready';
      $('#navUpdateBadge').hidden = next.status !== 'ready';
      const version = next.version ? 'v' + next.version : '새 버전';
      const messages = {
        idle: '새 버전을 자동으로 확인해요.',
        checking: '새 버전을 확인하고 있어요…',
        'up-to-date': '현재 최신 버전을 사용하고 있어요.',
        downloading: version + ' 다운로드 중… ' + Math.round(next.percent) + '%',
        ready: version + ' 준비 완료. 설치를 선택하면 저장과 백업을 확인한 뒤 다시 시작해요.',
        preparing: '저장과 백업을 확인하고 있어요…',
        installing: '저장된 내용을 확인했어요. 업데이트를 설치하고 다시 시작합니다…',
        error: '업데이트를 확인하거나 내려받지 못했어요. 지금 버전을 계속 사용하고 나중에 다시 시도해 주세요.',
        unsupported: next.disabledReason === 'store'
          ? 'Microsoft Store에서 업데이트를 확인해 주세요.'
          : '설치된 Windows 앱에서 업데이트를 확인할 수 있어요.',
      };
      status.textContent = ({
        save: '저장 완료를 확인하지 못해 업데이트하지 않았어요. 내용을 저장한 뒤 다시 시도해 주세요.',
        backup: '업데이트 전 백업을 만들지 못했어요. 저장 위치를 확인한 뒤 다시 시도해 주세요.',
        busy: '종료나 저장 확인이 진행 중이에요. 잠시 후 다시 시도해 주세요.',
        install: '설치를 시작하지 못했어요. 앱을 다시 실행한 뒤 업데이트를 확인해 주세요.',
      })[next.issue] || messages[next.status] || '업데이트 정보를 확인하고 있어요.';
    }
    async function command(action) {
      try { show(await action()); }
      catch { status.textContent = '업데이트 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'; }
    }
    const unsubscribe = api.onState(show);
    window.addEventListener('beforeunload', () => unsubscribe());
    check.addEventListener('click', () => { void command(() => api.check()); });
    install.addEventListener('click', () => { void command(() => api.install()); });
    void command(() => api.getState());
  }

  function renderSettings() {
    $('#set-category-list').replaceChildren(...data.categories.map((c) =>
      h('div', { class: 'category-manage-row' },
        h('span', { text: catName(c) }),
        h('button', { type: 'button', class: 'btn', 'aria-label': `${catName(c)} 편집·삭제`, onclick: () => openCatEdit(c.id) }, '편집·삭제'))));
    $('#set-weekStart').value = String(weekStart());
    $('#set-holidays').checked = data.settings.holidays !== false;
    $('#set-notify').checked = data.settings.notifications !== false;
    $('#set-notify-note').textContent = window.storage
      ? '일정에 설정한 알림 시간에 데스크톱 알림이 떠요.'
      : '미리보기에서는 알림이 울리지 않아요. 설치한 앱에서 동작해요.';
    $('#set-summary').textContent = `현재 데이터: ${summaryOf(data)}`;
    $('#set-where').textContent = window.storage
      ? '저장 위치: 이 PC의 앱 데이터 폴더(planner-data.json). 앱을 다시 설치해도 그대로예요.'
      : '저장 위치: 이 브라우저 안(미리보기용). 실제 앱의 데이터와는 따로예요.';
    $('#set-undo').hidden = !state.undoImport;

    // 설치한 앱에서만 되는 항목
    const native = window.PlannerNative;
    $('#set-keep').checked = data.settings.keepRunning !== false;
    $('#set-autostart').checked = data.settings.autoStart === true;
    for (const id of ['#set-keep', '#set-autostart', '#set-folder', '#set-folderOpen', '#set-folderReset', '#set-backupNow', '#set-backupOpen']) {
      $(id).disabled = !native;
    }
    $('#set-sysNote').hidden = !!native;
    if (native) refreshNative();
    else {
      $('#set-path').textContent = '미리보기에서는 쓸 수 없어요 (설치한 앱에서 동작)';
      $('#set-backups').replaceChildren(h('p', { class: 'muted set-summary', text: '설치한 앱에서 자동 백업 목록이 여기에 보여요.' }));
    }
  }

  const fmtBackupLabel = (b) => {
    const [y, m, d] = b.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const t = b.time ? ` ${b.time.slice(0, 2)}:${b.time.slice(2, 4)}` : '';
    return `${m}월 ${d}일 (${DOW[dt.getDay()]})${t}`;
  };

  // 저장 위치와 백업 목록을 앱에서 받아 화면에 채웁니다.
  async function refreshNative() {
    const native = window.PlannerNative;
    if (!native) return;
    try {
      const info = await native.info();
      $('#set-path').textContent = info.dataFile;
      $('#set-pathProblem').hidden = !info.problem;
      $('#set-pathProblem').textContent = info.problem || '';
      $('#set-folderReset').hidden = !info.custom;
      const list = await native.listBackups();
      renderBackupList(list);
    } catch (e) {
      console.error(e);
    }
  }

  const restoreArmed = new Map();
  function renderBackupList(list) {
    const box = $('#set-backups');
    box.replaceChildren();
    if (!list.length) { box.append(h('p', { class: 'muted set-summary', text: '아직 백업이 없어요. 내일부터 자동으로 쌓여요.' })); return; }
    for (const b of list) {
      const btn = h('button', { type: 'button', class: 'late-btn' }, '복원');
      btn.addEventListener('click', async () => {
        if (!restoreArmed.get(b.name)) {
          btn.textContent = '한 번 더';
          btn.classList.add('armed');
          restoreArmed.set(b.name, setTimeout(() => { restoreArmed.delete(b.name); btn.textContent = '복원'; btn.classList.remove('armed'); }, 3500));
          return;
        }
        clearTimeout(restoreArmed.get(b.name));
        restoreArmed.delete(b.name);
        btn.disabled = true;
        try {
          const r = await window.PlannerNative.restoreBackup(b.name);
          if (r.error) { $('#set-backupMsg').textContent = r.error; $('#set-backupMsg').className = 'set-msg err'; return; }
          applyLoaded(r.data);
          render();
          $('#set-backupMsg').textContent = `${fmtBackupLabel(b)} 백업으로 복원했어요.`;
          $('#set-backupMsg').className = 'set-msg ok';
        } catch {
          $('#set-backupMsg').textContent = '백업을 복원하지 못했어요. 저장 상태와 백업 파일을 확인한 뒤 다시 시도해 주세요.';
          $('#set-backupMsg').className = 'set-msg err';
        } finally { btn.disabled = false; }
      });
      box.append(h('div', { class: 'bk-row' },
        h('span', { class: 'bk-name', text: fmtBackupLabel(b) + (b.time ? ' · 수동/복원 전' : '') }),
        h('span', { class: 'muted', text: b.counts ? `일정 ${b.counts.events} · 할 일 ${b.counts.todos} · 목표 ${b.counts.projects}` : '읽을 수 없음' }),
        btn));
    }
  }

  function downloadBackup() {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `my-planner-backup-${fmtDate(new Date())}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setMsg('파일로 저장을 시도했어요. 저장되지 않으면 "내용 복사"를 쓰세요.', '');
  }

  async function copyBackup() {
    const text = exportJson();
    const box = $('#set-exportBox');
    box.value = text;
    try {
      await navigator.clipboard.writeText(text);
      box.hidden = true;
      setMsg('백업 내용을 복사했어요. 메모장 등에 붙여넣어 보관하세요.', 'ok');
    } catch {
      box.hidden = false; // 복사가 막힌 환경: 직접 복사하도록 보여 줍니다.
      box.focus();
      box.select();
      setMsg('자동 복사가 막혀 있어요. 아래 내용을 직접 복사(Ctrl+C)하세요.', '');
    }
  }

  let importArmed = null;
  function importBackup() {
    const btn = $('#set-import');
    const text = $('#set-importBox').value.trim();
    if (!text) { setMsg('가져올 백업 내용을 붙여넣거나 파일을 골라 주세요.', 'err'); return; }
    const r = parseBackup(text);
    if (r.error) { setMsg(r.error, 'err'); return; }
    if (!importArmed) {
      setMsg(`${summaryOf(r.obj)} 로 바꿔요. 맞으면 한 번 더 누르세요.`, '');
      btn.textContent = '한 번 더 눌러 가져오기';
      btn.classList.add('armed');
      importArmed = setTimeout(resetImportBtn, 6000);
      return;
    }
    resetImportBtn();
    state.undoImport = JSON.parse(JSON.stringify(data)); // 실수했을 때 되돌릴 수 있게 보관
    applyLoaded(r.obj);
    save();
    $('#set-importBox').value = '';
    render();
    setMsg(`가져왔어요. ${summaryOf(data)}` + (state.lastDropped ? ` (형식이 올바르지 않은 ${state.lastDropped}개 항목은 제외했어요)` : ''), 'ok');
  }
  function resetImportBtn() {
    clearTimeout(importArmed);
    importArmed = null;
    const btn = $('#set-import');
    btn.textContent = '가져오기';
    btn.classList.remove('armed');
  }

  function undoImport() {
    if (!state.undoImport) return;
    applyLoaded(state.undoImport);
    state.undoImport = null;
    save();
    render();
    setMsg('가져오기 전 상태로 되돌렸어요.', 'ok');
  }

  (async function init() {
    const loaded = await window.PlannerStorage.load();
    const needsSave = !(loaded.settings && loaded.settings.taskTrackingSince) || !Array.isArray(loaded.categories);
    applyLoaded(loaded);
    if (needsSave) save(); // 빠진 기본값을 채운 상태로 한 번 저장
    bind();
    render();
    loadAppVersion();
    loadUpdates();
  })();
})();
