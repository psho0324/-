const { chromium } = require('playwright');

const S = require('path').join(__dirname, 'out'); // 스크린샷이 저장되는 폴더
require('fs').mkdirSync(S, { recursive: true });
const URL = process.env.PLANNER_PREVIEW_URL || 'file://' + __dirname + '/preview/index.html';
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  -> ' + extra : ''));
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('planner-data')));
  const settle = () => page.waitForTimeout(250);
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
  const visible = (sel) => page.isVisible(sel);
  const chipTexts = () => page.$$eval('#calendar .chip', (els) => els.map((e) => e.textContent));

  await page.goto(URL);
  await page.waitForSelector('.home');

  // ================= 시작 화면 = 홈 =================
  check('앱을 켜면 홈이 먼저 보임', (await visible('#page-home')) && !(await visible('#page-calendar')));
  const expectDate = await page.evaluate(() => {
    const n = new Date(); const d = ['일', '월', '화', '수', '목', '금', '토'][n.getDay()];
    return `${n.getFullYear()}년 ${n.getMonth() + 1}월 ${n.getDate()}일 (${d})`;
  });
  check('홈 상단에 오늘 날짜 표시("null" 같은 군더더기 없음)', (await text('#homeDate')).startsWith(expectDate) && !(await text('#homeDate')).includes('null') && !(await text('#homeDate')).includes('undefined'), await text('#homeDate'));
  check('홈 설명 문구', (await text('#page-home .page-desc')) === '오늘의 현황을 한눈에');
  await page.screenshot({ path: S + '/shot2-home.png' });

  // ================= 사이드바 =================
  const navLabels = await page.$$eval('.nav-item .ni-label', (e) => e.map((x) => x.textContent));
  check('메뉴 6개 이름', JSON.stringify(navLabels) === JSON.stringify(['홈', '캘린더', '할 일', '목표', '통계', '설정']), navLabels.join(','));
  const descs = await page.$$eval('.nav-item .ni-desc', (e) => e.map((x) => x.textContent));
  check('메뉴 설명 문구', descs.join('|') === '오늘의 현황을 한눈에|일정과 시간표|작업 관리|성과와 작업 진행 관리|활동 기록과 분석|앱 환경 및 데이터 관리', descs.join('|'));
  check('통계·설정 메뉴 모두 활성', !(await page.$eval('[data-nav="stats"]', (b) => b.disabled)) && !(await page.$eval('[data-nav="settings"]', (b) => b.disabled)));
  check('카테고리 6개(5 + 미분류), 편집 버튼 5개', (await page.$$('.cat-item')).length === 6 && (await page.$$('.cat-edit')).length === 5);
  check('현재 메뉴(홈) 강조', await page.$eval('[data-nav="home"]', (b) => b.classList.contains('active')));

  // ================= 홈: 작은 달력 =================
  check('작은 달력 42칸 + 오늘 표시', (await page.$$('.mc-day')).length === 42 && (await page.$$('.mc-day.today')).length === 1);
  check('작은 달력에 점 표시(일정/할 일/목표일)', (await page.$$('.mc-dots i')).length > 0, (await page.$$('.mc-dots i')).length);
  // 달 이동
  const titleBefore = await text('.mc-title');
  await page.click('.mc-head .icon-btn:last-child');
  check('작은 달력 다음 달 이동', (await text('.mc-title')) !== titleBefore, `${titleBefore} -> ${await text('.mc-title')}`);
  await page.click('.mc-title');
  check('제목 누르면 이번 달로 복귀', (await text('.mc-title')) === titleBefore);

  // ================= 홈: 오늘 요약 =================
  const todayKey = await page.evaluate(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; });
  let d = await stored();
  const todayTodos = d.todos.filter((t) => t.due === todayKey);
  check('원그래프(SVG) 표시', (await page.$$('.stat-ring-card svg circle')).length >= 1);
  const TC = '.card:has(h2:has-text("오늘 할 일"))';
  const schedRows = (await page.$$(TC + ' .sch')).length;
  const todoRows = (await page.$$(TC + ' .todo')).length;
  check('오늘 일정 줄이 오늘 할 일 카드 안에 있음', schedRows >= 2, schedRows);
  check('오늘 할 일 카드 = 할 일 + 일정 합친 목록', todoRows === todayTodos.length && schedRows + todoRows === (await page.$$(TC + ' .sch, ' + TC + ' .todo')).length);
  check('완료 수 = 0/(할 일+일정)', (await text('.stat-ring-card .stat-num')) === `0/${todayTodos.length + schedRows}`, await text('.stat-ring-card .stat-num'));
  check('"남은 일정" 타일은 없어짐', !(await page.evaluate(() => document.body.innerText)).includes('남은 일정'));
  const overdueN = d.todos.filter((t) => !t.done && t.due && t.due < todayKey).length;
  check('밀린 할 일 타일 수 = 기한 지난 할 일', Number(await text('.stat-tile .stat-num')) === overdueN, overdueN);
  check('밀린 할 일 카드 제목에 개수', overdueN === 0 || (await text('.card-head h2:has-text("밀린 할 일")')) === `밀린 할 일 ${overdueN}`);
  check('기한 지난 할 일에 "N일 지남" 배지', overdueN === 0 || (await page.$$('#homeBody .badge.overdue')).length === overdueN);

  // 홈에서 체크 → 완료율 + completedAt 기록
  const firstToday = d.todos.find((t) => t.due === todayKey && !t.done);
  await page.click(`#homeBody .todo:has-text("${firstToday.title}") input[type=checkbox]`);
  await settle();
  d = await stored();
  const t1 = d.todos.find((t) => t.id === firstToday.id);
  check('체크하면 done + completedAt 기록', t1.done === true && typeof t1.completedAt === 'number', t1.completedAt);
  check('완료율 원이 갱신', (await text('.stat-ring-card .ring-center')).includes('%') && !(await text('.stat-ring-card .ring-center')).startsWith('0%'), (await text('.stat-ring-card .ring-center')));
  await page.click(`#homeBody .todo:has-text("${firstToday.title}") input[type=checkbox]`);
  await settle();
  d = await stored();
  const t2 = d.todos.find((t) => t.id === firstToday.id);
  check('체크 해제하면 completedAt 삭제', t2.done === false && !('completedAt' in t2));

  // 일정 체크 → doneOn 기록 + 완료율 반영
  const evRow = page.locator(TC + ' .sch:has-text("운동")').first();
  const totalNow = todayTodos.length + schedRows;
  await evRow.locator('input[type=checkbox]').click();
  await settle();
  d = await stored();
  const s3 = d.events.find((e) => e.id === 's3');
  check('일정 체크하면 doneOn[오늘] 기록', s3.doneOn && typeof s3.doneOn[todayKey] === 'number', JSON.stringify(s3.doneOn));
  check('완료 수에 일정이 포함(1/N)', (await text('.stat-ring-card .stat-num')) === `1/${totalNow}`, await text('.stat-ring-card .stat-num'));
  check('체크한 일정 줄은 done 스타일', await page.locator(TC + ' .sch.done').count() === 1);
  check('체크한 일정은 목록 맨 아래쪽(미완료 먼저)', await page.$$eval(TC + ' .sch, ' + TC + ' .todo', (e) => { const i = e.findIndex((x) => x.classList.contains('done')); return e.slice(i).every((x) => x.classList.contains('done')); }));
  // 반복 일정: 오늘만 완료, 내일 회차는 영향 없음
  check('반복 일정은 다른 날짜 기록 없음', Object.keys(s3.doneOn).length === 1);
  // 일정 대화상자에서도 같은 상태
  await page.locator(TC + ' .sch:has-text("운동") .sch-title').click();
  await page.waitForSelector('#eventDialog[open]');
  check('일정 대화상자에 "이 일정 완료" 체크 표시', (await visible('#ev-done-row')) && await page.$eval('#ev-done', (c) => c.checked));
  await page.uncheck('#ev-done');
  await page.click('#eventDialog button[type=submit]');
  await settle();
  d = await stored();
  check('대화상자에서 해제 → doneOn 비워짐', Object.keys(d.events.find((e) => e.id === 's3').doneOn || {}).length === 0);
  check('완료 수 다시 0/N', (await text('.stat-ring-card .stat-num')) === `0/${totalNow}`, await text('.stat-ring-card .stat-num'));
  // 달력에서 새 일정 만들 때는 완료 체크가 숨겨짐
  await page.click('[data-nav="calendar"]');
  await page.click('#newEvent');
  await page.waitForSelector('#eventDialog[open]');
  check('새 일정 대화상자에는 완료 체크 없음', !(await visible('#ev-done-row')));
  await page.keyboard.press('Escape');
  await page.click('[data-nav="home"]');

  // 홈 빠른 추가  // 목표 원그래프
  const goalRows = await page.$$('.goal-row');
  check('홈 목표 카드: 목표별 원(최대 4)', goalRows.length >= 1 && goalRows.length <= 4 && (await page.$$('.goal-row svg')).length === goalRows.length, goalRows.length);
  check('목표 진행률 표시(분기 보고서 33%)', (await text('.goal-row:has-text("분기 보고서") .ring-center')) === '33%', await text('.goal-row:has-text("분기 보고서") .ring-center'));

  // ================= 홈은 필터를 무시 =================
  await page.click('.cat-item:has-text("운동") .cat-toggle');
  check('운동 끄면 홈 오늘 일정은 그대로(필터 무시)', (await page.$$(TC + ' .sch')).length === schedRows);
  await page.click('.cat-item:has-text("운동") .cat-toggle');

  // ================= 작은 달력 날짜 → 캘린더 일 뷰 =================
  await page.click('.mc-day:not(.other):has-text("15")');
  await page.waitForSelector('#page-calendar:not([hidden])');
  check('날짜 누르면 캘린더 메뉴로 이동', await visible('.tg-body'));
  check('이동한 날짜가 15일', (await page.$eval('#dp-day', (s) => s.value)) === '15', await page.$eval('#dp-day', (s) => s.value));
  check('캘린더 메뉴 강조', await page.$eval('[data-nav="calendar"]', (b) => b.classList.contains('active')));

  // ================= 사이드바 필터가 캘린더에 적용 =================
  await page.click('[data-view="month"]');
  await page.click('#today');
  const hasChip = async (t) => (await chipTexts()).some((x) => x.includes(t));
  check('캘린더 월 뷰에 운동 일정', await hasChip('운동 (예시)'));
  await page.click('.cat-item:has-text("운동") .cat-toggle');
  check('운동 끄면 캘린더에서 사라짐', !(await hasChip('운동 (예시)')));
  check('필터 해제 버튼 표시', await visible('#fclear'));
  await page.click('#fclear');
  check('필터 해제하면 돌아옴', await hasChip('운동 (예시)'));
  await page.dblclick('.cat-item:has-text("업무") .cat-toggle');
  const only = await chipTexts();
  check('더블클릭=업무만 보기', only.some((x) => x.includes('팀 회의')) && !only.some((x) => x.includes('점심 약속')));
  await page.click('#newEvent');
  check('필터 하나일 때 새 일정 기본 카테고리=업무', (await page.$eval('#ev-cat', (s) => s.options[s.selectedIndex].text)) === '업무');
  await page.click('#ev-cancel');
  await page.click('#fclear');
  await page.fill('#searchBox', '치과');
  const q = await chipTexts();
  check('검색 "치과"', q.some((x) => x.includes('치과')) && !q.some((x) => x.includes('팀 회의')));
  await page.fill('#searchBox', '');

  // ================= 카테고리 편집/추가/삭제 (사이드바) =================
  await page.hover('.cat-item:has-text("업무")');
  await page.click('.cat-item:has-text("업무") .cat-edit');
  check('편집 대화상자 열림(이름 = 업무)', (await page.$eval('#cat-name', (i) => i.value)) === '업무');
  await page.fill('#cat-name', '회사');
  check('이름 변경이 사이드바에 즉시 반영', (await page.$$eval('.cat-name', (e) => e.map((x) => x.textContent))).includes('회사'));
  await page.click('#cat-colors .swatch:nth-child(2)');
  const boxColor = await page.$eval('.cat-item:has-text("회사")', (e) => e.style.getPropertyValue('--c'));
  check('색 변경이 즉시 반영', boxColor.toLowerCase() === '#ef4444', boxColor);
  await page.click('#catForm button[type=submit]');
  check('완료 누르면 닫힘', !(await visible('#catDialog')));
  await page.click('#catNew');
  check('+ 누르면 저장 전 새 카테고리 대화상자', (await text('#catDlgTitle')) === '새 카테고리' && (await page.$$('.cat-item')).length === 6);
  await page.fill('#cat-name', '독서');
  await page.click('#catForm button[type=submit]');
  await page.hover('.cat-item:has-text("독서")');
  await page.click('.cat-item:has-text("독서") .cat-edit');
  const colors = await page.$$eval('.cat-item', (e) => e.map((x) => x.style.getPropertyValue('--c').toLowerCase()));
  check('새 카테고리 색이 기존과 겹치지 않음', new Set(colors.slice(0, -1)).size === colors.slice(0, -1).length && !colors.slice(0, -2).includes(colors[colors.length - 2]) , colors.join(','));
  await page.click('#cat-delete');
  await settle();
  d = await stored();
  check('삭제하면 카테고리 사라짐', !d.categories.some((c) => c.name === '독서') && (await page.$$('.cat-item')).length === 6);
  // 회사(구 업무) 삭제 → 일정은 색 유지
  await page.hover('.cat-item:has-text("회사")');
  await page.click('.cat-item:has-text("회사") .cat-edit');
  await page.click('#cat-delete');
  await settle();
  d = await stored();
  const s1 = d.events.find((e) => e.id === 's1');
  check('카테고리 삭제: 일정은 미분류 + 기존 색 유지', s1 && s1.categoryId === null && s1.color === '#ef4444', s1 && `${s1.categoryId}/${s1.color}`);

  // ================= 할 일 페이지 =================
  await page.click('[data-nav="todos"]');
  check('할 일 페이지 + 설명', (await visible('#page-todos')) && (await text('#page-todos .page-desc')) === '작업 관리');
  check('할 일 목록 표시', (await page.$$('#todoList .todo')).length > 0, (await page.$$('#todoList .todo')).length);
  check('사이드바에 남은 할 일 수', (await text('#navTodoCount')) !== '', await text('#navTodoCount'));
  await page.fill('#todoNew', '세금 신고');
  await page.selectOption('#todoNewCat', { label: '개인' });
  await page.selectOption('#todoNewProj', { label: '분기 보고서 마무리 (예시)' });
  await page.press('#todoNew', 'Enter');
  await settle();
  check('카테고리·목표를 지정해 할 일 추가', (await text('#todoList .todo:has-text("세금 신고") .todo-sub')).includes('분기 보고서'));

  // ================= 목표 페이지 =================
  await page.click('[data-nav="goals"]');
  check('목표 페이지 + 설명', (await visible('#page-goals')) && (await text('#page-goals .page-desc')) === '성과와 작업 진행 관리');
  check('목표 카드 3개', (await page.$$('article.proj')).length === 3, (await page.$$('article.proj')).length);
  const cnt = await text('article.proj:has-text("분기 보고서") .proj-count');
  check('할 일 추가가 목표 진행률에 반영(1/4)', cnt.includes('1/4'), cnt);
  await page.screenshot({ path: S + '/shot2-goals.png' });
  await page.fill('#projNew', '이사 준비');
  await page.press('#projNew', 'Enter');
  await settle();
  check('새 목표 추가', await visible('article.proj:has-text("이사 준비")'));
  await page.click('article.proj:has-text("이사 준비") .proj-head');
  await page.selectOption('#pj-status', 'done');
  await page.click('#projForm button[type=submit]');
  await settle();
  d = await stored();
  const pj = d.projects.find((p) => p.title === '이사 준비');
  check('목표 완료 처리 시 completedAt 기록', pj.status === 'done' && typeof pj.completedAt === 'number');
  await page.click('article.proj:has-text("분기 보고서") .proj-head');
  check('목표 대화상자 제목 "목표 편집"', (await text('#projDialog h2')) === '목표 편집');
  await page.click('#pj-cancel');

  // ================= 끌어서 이동 =================
  const addKey = (k, n) => { const [y, m, dd] = k.split('-').map(Number); const x = new Date(y, m - 1, dd + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="month"]');
  await page.click('#today');
  await settle();
  let dd0 = await stored();
  const s2 = dd0.events.find((e) => e.id === 's2');
  const D = s2.start.slice(0, 10);
  const T = addKey(D, 2);
  check('반복 일정 칩은 끌 수 없음', (await page.$$eval('#calendar .chip:has-text("팀 회의")', (e) => e.every((x) => !x.draggable))) && (await page.$$eval('#calendar .chip:has-text("점심 약속")', (e) => e.every((x) => x.draggable))));
  await page.dragAndDrop(`[data-date="${D}"] .chip:has-text("점심 약속")`, `.cell[data-date="${T}"]`);
  await settle();
  dd0 = await stored();
  const s2b = dd0.events.find((e) => e.id === 's2');
  check('월 뷰: 일정을 다른 날로 끌면 날짜만 이동(시간 유지)', s2b.start === T + 'T' + s2.start.slice(11) && s2b.end === T + 'T' + s2.end.slice(11), s2b.start + ' ~ ' + s2b.end);
  check('이동 안내 토스트 + 칩이 새 날짜 칸에 있음', (await text('#toast')).includes('옮겼어요') && (await page.$$(`.cell[data-date="${T}"] .chip:has-text("점심 약속")`)).length === 1);
  await page.click('#toast .toast-btn');
  await settle();
  check('실행 취소 → 원래 날짜', (await stored()).events.find((e) => e.id === 's2').start === s2.start);
  // 할 일 끌기
  const t2d = (await stored()).todos.find((t) => t.id === 't2');
  const TD = addKey(t2d.due, 1);
  await page.dragAndDrop(`[data-date="${t2d.due}"] .chip.todo:has-text("장보기")`, `.cell[data-date="${TD}"]`);
  await settle();
  check('할 일 칩을 끌면 마감일 변경', (await stored()).todos.find((t) => t.id === 't2').due === TD);
  await page.click('#toast .toast-btn');
  await settle();
  check('할 일 이동도 실행 취소', (await stored()).todos.find((t) => t.id === 't2').due === t2d.due);
  // 주 뷰: 시간 이동
  await page.click('[data-view="week"]');
  if (!(await page.$(`.tg-col[data-date="${D}"] .tg-event:has-text("치과")`))) { await page.click('#next'); await settle(); }
  const dentist = (await stored()).events.find((e) => e.id === 's6');
  const dDay = dentist.start.slice(0, 10);
  const evSel = `.tg-col[data-date="${dDay}"] .tg-event:has-text("치과")`;
  let bb = await (await page.$(evSel)).boundingBox();
  const colW = (await (await page.$(`.tg-col[data-date="${dDay}"]`)).boundingBox()).width;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8 + 24, { steps: 4 });
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 8 + 48, { steps: 4 });
  await page.mouse.up();
  await settle();
  const dentist2 = (await stored()).events.find((e) => e.id === 's6');
  check('주 뷰: 아래로 1시간 끌면 시간이 +1시간(15분 단위)', dentist2.start === dDay + 'T11:30' && dentist2.end === dDay + 'T12:30', dentist2.start + ' ~ ' + dentist2.end);
  check('끌고 난 뒤 일정 편집 창은 열리지 않음', (await page.$('#eventDialog[open]')) === null);
  // 옆 칸(다음 날)으로 + 30분 위로
  const evSel2 = `.tg-col[data-date="${dDay}"] .tg-event:has-text("치과")`;
  bb = await (await page.$(evSel2)).boundingBox();
  const sameWeek = (await page.$(`.tg-col[data-date="${addKey(dDay, 1)}"]`)) !== null;
  if (sameWeek) {
    await page.mouse.move(bb.x + bb.width / 2, bb.y + 8);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + colW, bb.y + 8 - 24, { steps: 6 });
    await page.mouse.up();
    await settle();
    const dentist3 = (await stored()).events.find((e) => e.id === 's6');
    check('주 뷰: 옆 칸으로 끌면 날짜+1, 30분 위로', dentist3.start === addKey(dDay, 1) + 'T11:00' && dentist3.end === addKey(dDay, 1) + 'T12:00', dentist3.start + ' ~ ' + dentist3.end);
  } else {
    check('주 뷰: 옆 칸 이동(주 경계라 생략)', true);
  }
  await page.click('#toast .toast-btn');
  await settle();
  await page.click('#toast .toast-btn').catch(() => {});
  await page.evaluate((orig) => { const d = JSON.parse(localStorage.getItem('planner-data')); const e = d.events.find((x) => x.id === 's6'); e.start = orig.start; e.end = orig.end; localStorage.setItem('planner-data', JSON.stringify(d)); }, dentist);
  await page.reload();
  await page.waitForSelector('.home');
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="month"]');
  await page.click('#today');
  await page.click('[data-nav="home"]');

  // ================= 공휴일 =================
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="month"]');
  await page.selectOption('#dp-year', '2026');
  await page.selectOption('#dp-month', { label: '10월' });
  await settle();
  const holCells = await page.$$eval('#calendar .cell', (cs) => cs.filter((c) => c.querySelector('.hol-name')).map((c) => c.querySelector('.num').textContent + ':' + c.querySelector('.hol-name').textContent));
  check('2026년 10월 월 뷰: 개천절·대체공휴일·한글날 표시', holCells.join(',') === '3:개천절,5:대체공휴일(개천절),9:한글날', holCells.join(','));
  check('공휴일 날짜 숫자는 빨간색 클래스', (await page.$$('#calendar .cell:not(.other) .num.hol')).length === 3);
  const red = await page.$eval('#calendar .cell .num.hol', (e) => getComputedStyle(e).color);
  const sunC = await page.evaluate(() => { const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--sun'); document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; });
  check('공휴일 글자색 = 일요일 색', red === sunC, red);
  await page.click('[data-view="week"]');
  await page.selectOption('#dp-day', '5');
  await settle();
  check('주 뷰 머리글에 공휴일 이름', (await page.$$eval('.tg-dayhead .hol-name', (e) => e.map((x) => x.textContent))).includes('대체공휴일(개천절)'));
  await page.click('[data-view="day"]');
  check('일 뷰에도 공휴일 이름', (await page.$$eval('.tg-dayhead .hol-name', (e) => e.map((x) => x.textContent))).join() === '대체공휴일(개천절)');
  await page.click('[data-view="month"]');
  await page.click('[data-nav="settings"]');
  check('설정의 공휴일 표시 기본값 켜짐', await page.$eval('#set-holidays', (c) => c.checked));
  await page.uncheck('#set-holidays');
  await settle();
  check('끄면 설정 저장됨', (await stored()).settings.holidays === false);
  await page.click('[data-nav="calendar"]');
  check('끄면 공휴일 표시가 모두 사라짐', (await page.$$('#calendar .hol-name')).length === 0 && (await page.$$('#calendar .num.hol')).length === 0);
  await page.click('[data-nav="settings"]');
  await page.check('#set-holidays');
  await settle();
  await page.click('[data-nav="calendar"]');
  check('다시 켜면 표시 복구', (await page.$$('#calendar .hol-name')).length === 3);
  await page.click('#today');
  await page.click('[data-nav="home"]');

  // ================= 삭제 실행 취소 =================
  await page.click('[data-nav="home"]');
  await page.fill('#homeQuick', '임시 삭제 테스트');
  await page.press('#homeQuick', 'Enter');
  await settle();
  await page.click('[data-nav="todos"]');
  const nTodos = (await stored()).todos.length;
  await page.click('#todoList .todo-title:has-text("임시 삭제 테스트")');
  await page.waitForSelector('#todoDialog[open]');
  await page.click('#td-delete');
  await settle();
  check('할 일 삭제 → 목록에서 사라지고 토스트', (await stored()).todos.length === nTodos - 1 && (await text('#toast')).includes('"임시 삭제 테스트" 할 일을 지웠어요') && (await text('#toast')).includes('실행 취소'));
  await page.click('#toast .toast-btn');
  await settle();
  check('실행 취소 → 같은 할 일이 돌아옴', (await stored()).todos.length === nTodos && (await stored()).todos.some((t) => t.title === '임시 삭제 테스트'));
  await page.click('#todoList .todo-title:has-text("임시 삭제 테스트")');
  await page.waitForSelector('#todoDialog[open]');
  await page.click('#td-delete');
  await settle();
  await page.keyboard.press('Control+z');
  await settle();
  check('Ctrl+Z 로도 되돌림', (await stored()).todos.length === nTodos && !(await page.isVisible('#toast')));
  // 삭제 뒤 다른 수정이 있으면 취소 만료
  await page.click('#todoList .todo-title:has-text("임시 삭제 테스트")');
  await page.waitForSelector('#todoDialog[open]');
  await page.click('#td-delete');
  await settle();
  await page.locator('#todoList .todo input[type=checkbox]').first().click();
  await settle();
  check('다른 수정이 생기면 토스트 사라지고 취소 불가', !(await page.isVisible('#toast')));
  await page.keyboard.press('Control+z');
  await settle();
  check('만료된 뒤 Ctrl+Z 는 아무 일도 안 함', (await stored()).todos.length === nTodos - 1);
  await page.locator('#todoList .todo input[type=checkbox]').first().click(); // 원복
  await settle();
  // 일정 삭제도 취소 가능
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="month"]');
  const nEv = (await stored()).events.length;
  await page.locator('#calendar .chip:has-text("점심 약속")').first().click();
  await page.waitForSelector('#eventDialog[open]');
  await page.click('#ev-delete-all');
  await settle();
  check('일정 삭제 → 토스트', (await stored()).events.length === nEv - 1 && (await text('#toast')).includes('일정을 지웠어요'));
  await page.click('#toast .toast-btn');
  await settle();
  check('일정 삭제 취소 → 복구', (await stored()).events.length === nEv && (await chipTexts()).some((t) => t.includes('점심 약속')));
  await page.click('[data-nav="home"]');

  // ================= 설정 페이지 =================
  await page.click('[data-nav="settings"]');
  check('설정 메뉴 → 설정 페이지', (await visible('#page-settings')) && !(await visible('#page-home')) && await page.$eval('[data-nav="settings"]', (b) => b.classList.contains('active')));
  check('캘린더 상단에서 요일 선택은 사라짐', (await page.$$('#weekStart')).length === 0);
  let dS = await stored();
  check('현재 데이터 요약 표시', (await text('#set-summary')).includes(`일정 ${dS.events.length}개`) && (await text('#set-summary')).includes(`할 일 ${dS.todos.length}개`), await text('#set-summary'));
  // 주 시작 요일
  await page.selectOption('#set-weekStart', '1');
  await settle();
  dS = await stored();
  check('주 시작 요일 월요일로 저장', dS.settings.weekStart === 1);
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="month"]');
  check('캘린더 첫 열이 월요일', (await page.$$eval('#calendar .dow, #calendar .month-dow, #calendar [class*="dow"]', (e) => e.map((x) => x.textContent.trim()).filter(Boolean)))[0] === '월');
  await page.click('[data-nav="settings"]');
  await page.selectOption('#set-weekStart', '0');
  // 알림 토글
  check('알림 기본값 켜짐', await page.$eval('#set-notify', (c) => c.checked));
  await page.uncheck('#set-notify');
  await settle();
  check('알림 끄면 settings.notifications=false 저장', (await stored()).settings.notifications === false);
  await page.check('#set-notify');
  await settle();
  check('다시 켜면 true', (await stored()).settings.notifications === true);
  // 카테고리 추가 버튼
  const catsBefore = (await stored()).categories.length;
  await page.click('#set-catNew');
  await page.waitForSelector('#catDialog[open]');
  await settle();
  check('설정의 카테고리 추가는 확정 전 저장 안 함', (await stored()).categories.length === catsBefore);
  await page.click('#cat-cancel');
  await settle();
  if (await page.$('#catDialog[open]')) await page.keyboard.press('Escape');
  await settle();
  // 내보내기: 복사(클립보드 권한 없음 → 직접 복사 상자)
  await page.click('#set-copy');
  await settle();
  const exported = await page.$eval('#set-exportBox', (t) => t.value);
  let exObj = null;
  try { exObj = JSON.parse(exported); } catch {}
  const live = await stored();
  check('내보내기 내용이 올바른 JSON', exObj && exObj.app === '내 플래너' && exObj.events.length === live.events.length && exObj.todos.length === live.todos.length && Array.isArray(exObj.categories));
  // 파일 저장(다운로드)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('#set-export')]);
  check('"파일로 저장" → my-planner-backup-날짜.json 다운로드', dl && /^my-planner-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl && dl.suggestedFilename());

  // 가져오기: 잘못된 내용
  await page.fill('#set-importBox', '이건 json 아님');
  await page.click('#set-import');
  check('잘못된 내용은 오류 안내, 데이터 그대로', (await text('#set-importMsg')).includes('읽을 수 없어요') && (await stored()).todos.length === live.todos.length);
  await page.fill('#set-importBox', JSON.stringify({ hello: 1 }));
  await page.click('#set-import');
  check('백업 형식이 아니면 거부', (await text('#set-importMsg')).includes('백업 파일이 아니에요'));
  // 가져오기: 정상 (두 번 눌러야 적용)
  const backup = { app: '내 플래너', events: [{ id: 'i1', title: '가져온 일정', allDay: true, start: '2026-12-01', end: '2026-12-01', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null }], todos: [{ id: 'i2', title: '가져온 할 일', done: false, due: null, priority: 1, memo: '', createdAt: 1 }, { id: 'i3', title: '가져온 할 일 2', done: true, due: null, priority: 1, memo: '', createdAt: 2 }], projects: [], categories: [{ id: 'c-x', name: '가져온 카테고리', color: '#10b981' }], settings: { weekStart: 1 } };
  await page.fill('#set-importBox', JSON.stringify(backup));
  await page.click('#set-import');
  check('첫 클릭: 요약 보여 주고 아직 안 바뀜', (await text('#set-importMsg')).includes('일정 1개 · 할 일 2개') && (await stored()).events.length === live.events.length && (await text('#set-import')).includes('한 번 더'));
  await page.click('#set-import');
  await settle();
  const imp = await stored();
  check('두 번째 클릭: 데이터가 가져온 내용으로 교체', imp.events.length === 1 && imp.events[0].title === '가져온 일정' && imp.todos.length === 2 && imp.categories.length === 1 && imp.settings.weekStart === 1);
  check('가져온 뒤 사이드바/요약 갱신', (await text('#set-summary')).includes('일정 1개') && (await page.$$('.cat-item')).length === 2, (await page.$$('.cat-item')).length);
  check('가져오기 성공 메시지 + 되돌리기 버튼', (await text('#set-importMsg')).includes('가져왔어요') && await visible('#set-undo'));
  // 되돌리기
  await page.click('#set-undo');
  await settle();
  const undone = await stored();
  check('되돌리기 → 원래 데이터 복구', undone.events.length === live.events.length && undone.todos.length === live.todos.length && undone.categories.length === live.categories.length);
  // 파일로 가져오기
  await page.setInputFiles('#set-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await settle();
  check('파일 선택 → 내용 채워지고 요약 안내', (await page.$eval('#set-importBox', (t) => t.value)).includes('가져온 일정') && (await text('#set-importMsg')).includes('backup.json'));
  await page.fill('#set-importBox', '');
  await page.reload();
  await page.waitForSelector('.home');

  // ================= 화면에 "프로젝트" 글자 없음 =================
  for (const nav of ['home', 'calendar', 'todos', 'goals', 'settings']) {
    await page.click(`[data-nav="${nav}"]`);
    const t = await page.evaluate(() => document.body.innerText);
    check(`${nav}: 화면에 "프로젝트" 없음`, !t.includes('프로젝트'));
  }

  // ================= 새로고침 후 유지 =================
  await page.click('.cat-item:has-text("운동") .cat-toggle');
  await settle();
  await page.reload();
  await page.waitForSelector('.home');
  check('새로고침 후에도 홈으로 시작', await visible('#page-home'));
  check('숨긴 카테고리 유지', await page.$eval('.cat-item:has-text("운동")', (e) => e.classList.contains('off')));

  // ================= 주/일 뷰 =================
  await page.click('[data-nav="calendar"]');
  await page.click('[data-view="week"]');
  check('주 뷰 렌더', await visible('.tg-head'));
  await page.click('[data-view="day"]');
  check('일 뷰 렌더', await visible('.tg-body'));
  await page.click('[data-view="month"]');

  // ================= 빠른 추가 =================
  await page.click('[data-nav="home"]');
  const cats0 = (await stored()).categories;
  const work = cats0[0]; // 앞선 테스트에서 '업무'를 지웠을 수 있어 남아 있는 첫 카테고리를 씁니다
  const evN = (await stored()).events.length;
  const tdN = (await stored()).todos.length;
  await page.click('#quickOpen');
  await page.waitForSelector('#quickDialog[open]');
  check('빠른 추가 창이 열리고 입력칸에 포커스', await page.$eval('#quickInput', (e) => e === document.activeElement));
  check('빈 입력이면 만들기 비활성 + 안내', (await page.$eval('#quickOk', (b) => b.disabled)) && (await text('#quickPreview')).includes('보여 드려요'));
  await page.fill('#quickInput', `내일 오후 3시 치과 1시간 #${work.name}`);
  const pv = await text('#quickPreview');
  console.log('   미리보기:', pv.replace(/\s+/g, ' '));
  check('미리보기: 일정 · 제목 · 시간 · 카테고리', pv.includes('일정') && pv.includes('치과') && pv.includes('15:00–16:00') && pv.includes('내일') && pv.includes(work.name), pv);
  await page.press('#quickInput', 'Enter');
  await settle();
  let dq = await stored();
  const made = dq.events[dq.events.length - 1];
  const tmr = await page.evaluate(() => { const x = new Date(); x.setDate(x.getDate() + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; });
  check('Enter → 일정 생성(내일 15:00~16:00, 카테고리)', dq.events.length === evN + 1 && made.title === '치과' && made.start === tmr + 'T15:00' && made.end === tmr + 'T16:00' && made.categoryId === work.id && made.color === work.color, JSON.stringify(made));
  check('창이 닫히고 토스트에 실행 취소', !(await page.$('#quickDialog[open]')) && (await text('#toast')).includes('일정을 만들었어요') && (await text('#toast')).includes('실행 취소'));
  await page.click('#toast .toast-btn');
  await settle();
  check('실행 취소 → 만든 일정이 사라짐', (await stored()).events.length === evN);
  // 할 일 + 중요 + 종류 전환
  await page.keyboard.press('q');
  await page.waitForSelector('#quickDialog[open]');
  await page.fill('#quickInput', `보고서 제출 금요일 ! #${work.name}`);
  check('날짜만 있으면 할 일로 미리보기', (await text('#quickPreview')).includes('할 일') && (await text('#quickPreview')).includes('중요'));
  await page.click('[data-qkind="event"]');
  check('종류를 일정으로 바꾸면 종일 일정으로 미리보기', (await text('#quickPreview')).includes('종일') && (await page.$eval('[data-qkind="event"]', (b) => b.classList.contains('active'))));
  await page.click('[data-qkind="todo"]');
  await page.click('#quickOk');
  await settle();
  dq = await stored();
  const madeT = dq.todos[dq.todos.length - 1];
  check('할 일 생성: 제목·마감일·중요·카테고리', dq.todos.length === tdN + 1 && madeT.title === '보고서 제출' && /^\d{4}-\d\d-\d\d$/.test(madeT.due) && new Date(madeT.due + 'T00:00').getDay() === 5 && madeT.priority === 2 && madeT.categoryId === work.id, JSON.stringify(madeT));
  await page.click('#toast .toast-btn');
  await settle();
  // Ctrl+K 로도 열림, Esc 로 닫힘
  await page.keyboard.press('Control+k');
  check('Ctrl+K 로 열림', !!(await page.$('#quickDialog[open]')));
  await page.keyboard.press('Escape');
  check('Esc 로 닫힘', !(await page.$('#quickDialog[open]')));
  check('빠른 추가 후 데이터 원상복구', (await stored()).todos.length === tdN && (await stored()).events.length === evN);

  // ================= 지난 일정 → 밀린 할 일 =================
  const page3 = await ctx.newPage();
  const errors3 = [];
  page3.on('pageerror', (e) => errors3.push(e.message));
  await page3.goto(URL);
  await page3.waitForTimeout(400); // 첫 로드의 초기 저장이 끝난 뒤에 데이터를 넣습니다
  const keyOf = (n) => page3.evaluate((n) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }, n);
  const k1 = await keyOf(-1), k2 = await keyOf(-2), k3 = await keyOf(-3), k20 = await keyOf(-20), k5 = await keyOf(-5);
  await page3.evaluate(([k1, k2, k3, k20, k5]) => localStorage.setItem('planner-data', JSON.stringify({
    events: [
      { id: 'a1', title: '어제 회의', allDay: false, start: k1 + 'T10:00', end: k1 + 'T11:00', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null },
      { id: 'a2', title: '그제 종일행사', allDay: true, start: k2, end: k2, repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null },
      { id: 'a3', title: '체크한 지난 일정', allDay: false, start: k2 + 'T09:00', end: k2 + 'T10:00', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null, doneOn: { [k2]: 1 } },
      { id: 'a4', title: '20일 전 일정', allDay: false, start: k20 + 'T09:00', end: k20 + 'T10:00', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null },
      { id: 'a5', title: '매일 산책', allDay: false, start: k3 + 'T07:00', end: k3 + 'T07:30', repeat: 'daily', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null, doneOn: { [k2]: 1 } },
    ],
    todos: [{ id: 'b1', title: '지난 할 일', done: false, due: k1, priority: 1, memo: '', createdAt: 1 }],
    projects: [], categories: [], settings: { defaultView: 'month', taskTrackingSince: k5 },
  })), [k1, k2, k3, k20, k5]);
  await page3.reload();
  await page3.waitForSelector('.home');
  const t3 = (sel) => page3.$eval(sel, (e) => e.textContent.trim());
  const LC = '.card:has(h2:has-text("밀린 할 일"))';
  const lateTexts = await page3.$$eval(LC + ' .sch-title, ' + LC + ' .todo-title', (e) => e.map((x) => x.textContent));
  console.log('   밀린 목록:', lateTexts.join(' | '));
  check('지난 일정이 밀린 할 일에 나옴(어제 회의, 그제 종일행사)', lateTexts.includes('어제 회의') && lateTexts.includes('그제 종일행사'));
  check('체크한 지난 일정은 안 나옴', !lateTexts.includes('체크한 지난 일정'));
  check('시작일(5일 전) 이전·7일 넘은 일정은 안 나옴', !lateTexts.includes('20일 전 일정'));
  check('반복 일정은 밀린 할 일에 안 나옴', !lateTexts.some((t) => t.includes('매일 산책')));
  check('기한 지난 할 일도 같은 목록', lateTexts.includes('지난 할 일'));
  console.log('   타일:', await page3.$$eval('.stat-tile .stat-num', (e) => e.map((x) => x.textContent)));
  check('밀린 개수 = 목록 = 타일 (3)', lateTexts.length === 3 && (await t3('.stat-tile .stat-num')) === '3', lateTexts.length);
  check('날짜순(오래된 것 먼저)', lateTexts[0].includes('그제 종일행사'), lateTexts[0]);
  await page3.screenshot({ path: S + '/shot2-late.png' });
  // 지난 일정 체크 → 목록에서 사라짐
  await page3.locator(LC + ' .sch:has-text("어제 회의") input[type=checkbox]').click();
  await page3.waitForTimeout(250);
  check('체크하면 밀린 목록에서 빠지고 개수 감소', (await t3('.stat-tile .stat-num')) === '2' && (await t3('.card-head h2:has-text("밀린 할 일")')) === '밀린 할 일 2');
  // 캘린더: 밀린 일은 빠지고, 반복 일정과 체크한 일정은 남음
  await page3.click('[data-nav="calendar"]');
  await page3.click('[data-view="month"]');
  const chips3 = await page3.$$eval('#calendar .chip', (e) => e.map((x) => x.textContent));
  console.log('   캘린더 칩:', chips3.join(' | '));
  check('캘린더에서 체크 안 한 지난 일정/할 일은 사라짐', !chips3.some((t) => t.includes('그제 종일행사') || t.includes('지난 할 일')));
  check('체크한 지난 일정(어제 회의·체크한 지난 일정)은 캘린더에 남음', chips3.some((t) => t.includes('어제 회의')) && chips3.some((t) => t.includes('체크한 지난 일정')));
  check('반복 일정은 지난 날짜에도 캘린더에 남음', chips3.filter((t) => t.includes('매일 산책')).length >= 3, chips3.filter((t) => t.includes('매일 산책')).length);
  check('시작일 이전(20일 전) 일정은 캘린더에 그대로', true);
  await page3.click('[data-nav="home"]');
  await page3.waitForTimeout(300); // 앱의 지연 저장(및 창 닫을 때 저장)이 끝난 뒤에 데이터를 바꿔 끼워요
  // 더 보기 (5개 초과 시)
  await page3.evaluate((k) => {
    const d = JSON.parse(localStorage.getItem('planner-data'));
    for (let i = 0; i < 4; i++) d.todos.push({ id: 'z' + i, title: '더미' + i, done: false, due: k, priority: 1, memo: '', createdAt: 5 + i });
    localStorage.setItem('planner-data', JSON.stringify(d));
  }, k1);
  await page3.reload();
  await page3.waitForSelector('.home');
  check('6개 이상이면 5개만 보이고 더 보기 버튼', (await page3.$$(LC + ' .sch, ' + LC + ' .todo')).length === 5 && (await page3.locator(LC + ' .link-btn:has-text("더 보기")').count()) === 1);
  await page3.click(LC + ' .link-btn:has-text("더 보기")');
  check('더 보기 → 전부 펼침', (await page3.$$(LC + ' .sch, ' + LC + ' .todo')).length === 6);
  // ----- 밀린 일 처리 (할 일 페이지의 밀린 일 탭)
  const stored3 = () => page3.evaluate(() => JSON.parse(localStorage.getItem('planner-data')));
  const kT = await keyOf(0), kTm = await keyOf(1);
  check('홈 밀린 줄마다 처리 버튼(오늘로·내일로·날짜·삭제)', (await page3.$$(LC + ' .late-actions')).length === 6 && (await page3.locator(LC + ' .late-btn').allTextContents()).slice(0, 4).join(',') === '오늘로,내일로,날짜,삭제');
  await page3.click('[data-nav="todos"]');
  check('할 일 페이지에 "밀린 일" 탭 + 개수 6', (await t3('[data-filter="late"]')).replace(/\s/g, '') === '밀린일6', await t3('[data-filter="late"]'));
  await page3.click('[data-filter="late"]');
  check('밀린 일 탭: 설명 막대 + 6줄(할 일 + 일정 합쳐서)', (await page3.isVisible('#lateBar')) && (await page3.$$('#todoList .late')).length === 6 && (await page3.$$('#todoList .sch')).length === 1 && (await page3.$$('#todoList .todo')).length === 5);
  const L = '#todoList .late';
  // 삭제: 바로 지워지고 "실행 취소" 토스트
  await page3.locator(L + ':has-text("더미0") .late-btn.danger').click();
  await page3.waitForTimeout(250);
  check('삭제하면 바로 지워지고 실행 취소 안내', !(await stored3()).todos.some((t) => t.title === '더미0') && (await page3.$$(L)).length === 5 && (await t3('#toast')).includes('실행 취소'));
  await page3.click('#toast .toast-btn');
  await page3.waitForTimeout(250);
  check('실행 취소 → 되살아남', (await stored3()).todos.some((t) => t.title === '더미0') && (await page3.$$(L)).length === 6 && !(await page3.isVisible('#toast')));
  await page3.locator(L + ':has-text("더미0") .late-btn.danger').click();
  await page3.waitForTimeout(250);
  check('다시 삭제', !(await stored3()).todos.some((t) => t.title === '더미0') && (await page3.$$(L)).length === 5);
  // 날짜 골라서 일정 옮기기
  await page3.locator(L + ':has-text("그제 종일행사") .late-date').fill(kTm);
  await page3.waitForTimeout(250);
  let d3 = await stored3();
  const a2 = d3.events.find((e) => e.id === 'a2');
  check('날짜 선택 → 종일 일정이 그 날짜로 이동', a2.start === kTm && a2.end === kTm, a2.start + '/' + a2.end);
  check('옮긴 일정은 밀린 목록에서 빠짐', (await page3.$$(L)).length === 4);
  // 내일로
  await page3.locator(L + ':has-text("지난 할 일") .late-btn:has-text("내일로")').click();
  await page3.waitForTimeout(250);
  d3 = await stored3();
  check('"내일로" → 할 일 기한이 내일', d3.todos.find((t) => t.id === 'b1').due === kTm);
  // 모두 오늘로
  await page3.click('#lateAllBtn');
  await page3.waitForTimeout(250);
  d3 = await stored3();
  check('"모두 오늘로" → 남은 할 일 전부 오늘 기한', ['z1', 'z2', 'z3'].every((id) => d3.todos.find((t) => t.id === id).due === kT));
  check('밀린 일이 비면 안내 문구', (await t3('#todoList .empty')).includes('밀린 일이 없어요') && (await t3('[data-filter="late"]')).replace(/\s/g, '') === '밀린일');
  // 시간 있는 일정 옮기기: 시간은 유지
  await page3.evaluate(([k]) => {
    const d = JSON.parse(localStorage.getItem('planner-data'));
    d.events.push({ id: 'a9', title: '시간 일정', allDay: false, start: k + 'T14:30', end: k + 'T16:00', repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null });
    localStorage.setItem('planner-data', JSON.stringify(d));
  }, [k3]);
  await page3.reload();
  await page3.waitForSelector('.home');
  await page3.locator('.card:has(h2:has-text("밀린 할 일")) .late:has-text("시간 일정") .late-btn:has-text("오늘로")').click();
  await page3.waitForTimeout(250);
  d3 = await stored3();
  const a9 = d3.events.find((e) => e.id === 'a9');
  check('시간 일정은 날짜만 오늘로, 시간은 유지', a9.start === kT + 'T14:30' && a9.end === kT + 'T16:00', a9.start + '/' + a9.end);
  check('홈에서 모두 처리하면 밀린 카드 사라짐', (await page3.$$(LC)).length === 0 && (await t3('.stat-tile .stat-num')) === '0');
  check('밀린 일 화면 오류 없음', errors3.length === 0, errors3.join(' / '));
  await page3.close();

  // ================= 통계 페이지 =================
  const page4 = await ctx.newPage();
  const errors4 = [];
  page4.on('pageerror', (e) => errors4.push(e.message));
  await page4.goto(URL);
  await page4.waitForTimeout(400);
  const kk = (n) => page4.evaluate((n) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }, n);
  const K = {}; for (const n of [0, -1, -2, -3, -4, -5, -10]) K[n] = await kk(n);
  const noon = (k) => new Date(k + 'T12:00:00').getTime();
  const ev = (id, title, start, end, extra = {}) => ({ id, title, allDay: false, start, end, repeat: 'none', repeatInterval: 1, repeatUntil: null, exceptions: [], reminder: null, ...extra });
  await page4.evaluate((D) => localStorage.setItem('planner-data', JSON.stringify(D)), {
    categories: [{ id: 'c1', name: '업무', color: '#3b82f6' }, { id: 'c2', name: '운동', color: '#f59e0b' }],
    todos: [
      { id: 't1', title: 'a', done: true, due: K[0], completedAt: noon(K[0]), priority: 1, createdAt: 1 },
      { id: 't2', title: 'b', done: true, due: K[-1], completedAt: noon(K[-1]), priority: 1, createdAt: 2 },
      { id: 't3', title: 'c', done: false, due: K[-2], priority: 1, createdAt: 3 },
      { id: 't4', title: 'd', done: true, due: K[-3], completedAt: noon(K[-3]), priority: 1, createdAt: 4 },
      { id: 't5', title: 'e', done: true, due: K[-1], completedAt: noon(K[-1]), projectId: 'p1', priority: 1, createdAt: 5 },
      { id: 't6', title: 'f', done: false, due: null, projectId: 'p1', priority: 1, createdAt: 6 },
    ],
    events: [
      ev('e1', '회의', K[-2] + 'T10:00', K[-2] + 'T12:00', { categoryId: 'c1', doneOn: { [K[-2]]: noon(K[-2]) } }),
      ev('e2', '발표', K[-1] + 'T14:00', K[-1] + 'T15:30', { categoryId: 'c1' }),
      ev('e3', '종일행사', K[-4], K[-4], { allDay: true, doneOn: { [K[-4]]: noon(K[-4]) } }),
      ev('e4', '메모', K[-5] + 'T09:00', K[-5] + 'T10:00'),
    ],
    projects: [{ id: 'p1', title: '목표A', due: null, categoryId: 'c1', status: 'active', createdAt: 1 }],
    settings: { defaultView: 'month', taskTrackingSince: K[-10] },
  });
  await page4.reload();
  await page4.waitForSelector('.home');
  const t4 = (sel) => page4.$eval(sel, (e) => e.textContent.trim());
  await page4.click('[data-nav="stats"]');
  await page4.click('[data-stat="d30"]');
  const tiles4 = await page4.$$eval('.stats-tiles .stat-tile', (e) => e.map((x) => [...x.children].map((c) => c.textContent.trim())));
  console.log('   통계 타일:', JSON.stringify(tiles4));
  check('통계 페이지 열림 + 기간 버튼 활성', (await page4.isVisible('#page-stats')) && (await page4.$eval('[data-stat="d30"]', (b) => b.classList.contains('active'))));
  check('완료한 일 6 (할 일 4 · 일정 2)', tiles4[0][1] === '6' && tiles4[0][2] === '할 일 4 · 일정 2', JSON.stringify(tiles4[0]));
  check('기한 달성률 67% (9개 중 6개 처리)', tiles4[1][1] === '67%' && tiles4[1][2] === '기한이 된 9개 중 6개 처리', JSON.stringify(tiles4[1]));
  check('연속 달성 5일', tiles4[2][1] === '5일', JSON.stringify(tiles4[2]));
  check('일정 시간 4.5시간', tiles4[3][1] === '4.5시간', JSON.stringify(tiles4[3]));
  check('막대그래프: 30칸, 완료가 있는 5일에 막대', (await page4.$$('.stat-svg .stat-hit title')).length === 30 && (await page4.$$('.stat-svg path')).length === 5, (await page4.$$('.stat-svg path')).length);
  const tipToday = await page4.$$eval('.stat-svg .stat-hit title', (e) => e[e.length - 1].textContent);
  check('오늘 칸 툴팁: 1개 완료', tipToday.endsWith(': 1개 완료'), tipToday);
  check('표로 보기: 완료 있는 날 5행', (await page4.$$('.stat-table tbody tr')).length === 5);
  const hrows = await page4.$$eval('.hbar-row', (e) => e.map((x) => x.textContent.trim().replace(/\s+/g, ' ')));
  console.log('   막대 행:', JSON.stringify(hrows));
  check('카테고리별 시간: 업무 3.5시간 → 미분류 1시간 순', hrows[0] === '업무3.5시간' && hrows[1] === '미분류1시간', JSON.stringify(hrows.slice(0, 2)));
  check('목표 진행: 목표A 50%', hrows.some((r) => r.startsWith('목표A') && r.includes('50%')), JSON.stringify(hrows));
  await page4.screenshot({ path: S + '/shot6-stats.png' });
  await page4.click('[data-stat="week"]');
  check('기간 바꾸면 버튼·내용 갱신(이번 주)', (await page4.$eval('[data-stat="week"]', (b) => b.classList.contains('active'))) && (await page4.$$('.stat-svg .stat-hit title')).length === 7);
  await page4.click('[data-stat="month"]');
  check('이번 달', (await page4.$$('.stat-svg .stat-hit title')).length >= 28 || (await page4.$$('.stat-svg')).length === 0);
  // 빈 상태
  await page4.evaluate((k) => localStorage.setItem('planner-data', JSON.stringify({ events: [], todos: [], projects: [], categories: [], settings: { taskTrackingSince: k } })), K[0]);
  await page4.reload();
  await page4.waitForSelector('.home');
  await page4.click('[data-nav="stats"]');
  check('기록이 없으면 안내 문구, 0 표시, 오류 없음', (await t4('#statsBody')).includes('완료한 기록이 없어요') && (await t4('.stats-tiles .stat-tile .stat-num')) === '0' && errors4.length === 0, errors4.join('/'));
  await page4.close();

  // ================= 깨진 데이터 방어 =================
  const page5 = await ctx.newPage();
  const errors5 = [];
  page5.on('pageerror', (e) => errors5.push(e.message));
  await page5.goto(URL);
  await page5.waitForTimeout(400);
  await page5.evaluate(() => localStorage.setItem('planner-data', JSON.stringify({
    events: [null, { id: 'x' }, { id: 'ok', title: '정상', start: '2026-11-10T10:00', end: 'garbage', repeat: 'hourly' }],
    todos: [null, 'text', 7, { title: '정상 할 일', due: '2026-13-45' }],
    projects: [{}, null], categories: ['a', null, { name: '정상 카테고리', color: 'red' }],
    settings: [1, 2],
  })));
  await page5.reload();
  await page5.waitForSelector('.home');
  await page5.waitForTimeout(300);
  for (const nav of ['calendar', 'todos', 'goals', 'stats', 'settings', 'home']) await page5.click(`[data-nav="${nav}"]`);
  const d5 = await page5.evaluate(() => JSON.parse(localStorage.getItem('planner-data')));
  check('깨진 항목(null·문자열·빈 객체)이 있어도 화면 오류 없이 열림', errors5.length === 0, errors5.join(' / '));
  check('깨진 항목은 정리되고 정상 항목은 보존', d5.events.length === 1 && d5.events[0].title === '정상' && d5.events[0].repeat === 'none' && d5.events[0].end === d5.events[0].start && d5.todos.length === 1 && d5.todos[0].due === null && d5.categories.length === 1 && d5.categories[0].color === '#3b82f6', JSON.stringify(d5).slice(0, 300));
  await page5.close();

  // ================= 옛 형식 데이터  // ================= 좁은 화면 / 다크 =================
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', colorScheme: 'dark' });
  const mp = await mobile.newPage();
  const merr = [];
  mp.on('pageerror', (e) => merr.push(e.message));
  await mp.goto(URL);
  await mp.waitForSelector('.home');
  const overflow = await mp.evaluate(() => {
    const app = document.querySelector('.app');
    return { app: app.scrollWidth - app.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth };
  });
  check('좁은 화면(390px): 가로 스크롤 없음', overflow.app <= 1 && overflow.doc <= 1, JSON.stringify(overflow));
  await mp.screenshot({ path: S + '/shot2-mobile-dark.png', fullPage: false });
  check('좁은 화면 오류 없음', merr.length === 0, merr.join(' / '));
  await mobile.close();

  check('콘솔/페이지 오류 없음', errors.length === 0, errors.join(' / '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
