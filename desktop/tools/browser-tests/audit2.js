const { chromium } = require('playwright');
const URL = 'file://' + __dirname + '/preview/index.html';
(async () => {
  const browser = await chromium.launch();
  const out = [];
  // ---- 1) 깨진 백업을 가져와도 화면이 살아 있나
  const bad = {
    '이벤트에 null': { events: [null], todos: [], projects: [] },
    '일정 필드 누락': { events: [{ id: 'x' }], todos: [], projects: [] },
    '날짜 형식 엉터리': { events: [{ id: 'x', title: 't', start: 'abc', end: 'def', repeat: 'none' }], todos: [], projects: [] },
    '할 일에 null/문자열': { events: [], todos: [null, 'a', 5], projects: [] },
    '목표 필드 누락': { events: [], todos: [], projects: [{}] },
    '카테고리가 문자열': { events: [], todos: [], projects: [], categories: ['a', null] },
    'settings가 배열': { events: [], todos: [], projects: [], settings: [1, 2] },
    '반복 값 이상': { events: [{ id: 'x', title: 't', allDay: false, start: '2026-11-01T10:00', end: '2026-11-01T11:00', repeat: 'hourly', repeatInterval: -5 }], todos: [], projects: [] },
    '아주 큰 반복': { events: [{ id: 'x', title: 't', allDay: false, start: '2000-01-01T10:00', end: '2000-01-01T11:00', repeat: 'daily', repeatInterval: 1, repeatUntil: null }], todos: [], projects: [] },
  };
  for (const [name, backup] of Object.entries(bad)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(URL);
    await page.waitForSelector('.home');
    await page.click('[data-nav="settings"]');
    await page.fill('#set-importBox', JSON.stringify(backup));
    await page.click('#set-import');
    await page.click('#set-import');
    await page.waitForTimeout(300);
    const msgs = [];
    for (const nav of ['home', 'calendar', 'todos', 'goals', 'stats']) {
      try { await page.click(`[data-nav="${nav}"]`, { timeout: 1500 }); await page.waitForTimeout(80); } catch { msgs.push('클릭불가:' + nav); }
    }
    for (const v of ['week', 'day', 'month']) { try { await page.click(`[data-nav="calendar"]`); await page.click(`[data-view="${v}"]`, { timeout: 1500 }); } catch {} }
    // 새로고침 후에도 열리나(깨진 데이터가 저장돼 앱이 못 켜지는 상황)
    await page.reload();
    let boots = true;
    try { await page.waitForSelector('.home', { timeout: 3000 }); await page.waitForTimeout(200); } catch { boots = false; }
    const visibleHome = boots && (await page.isVisible('#page-home'));
    out.push(`${errs.length || !visibleHome ? 'FAIL' : 'ok  '} ${name}: 오류 ${errs.length}건, 재시작 후 홈 ${visibleHome ? '열림' : '안 열림'} ${[...new Set(errs)].slice(0, 2).join(' / ').slice(0, 140)}`);
    await ctx.close();
  }
  console.log(out.join('\n'));
  await browser.close();
})();
