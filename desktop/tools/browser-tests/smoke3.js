// 저장 상태 표시 / 통계 문구 / 모바일 화면 점검
const { chromium } = require('playwright');
const S = require('path').join(__dirname, 'out'); // 스크린샷이 저장되는 폴더
require('fs').mkdirSync(S, { recursive: true });
const URL = 'file://' + __dirname + '/preview/index.html';
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  -> ' + extra : '')); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/저장 실패|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForSelector('.home');
  await page.waitForTimeout(400);

  const st = () => page.$eval('#saveStatus', (e) => ({ hidden: e.hidden, state: e.dataset.state, text: e.textContent.trim(), role: e.getAttribute('role') }));
  const stored = () => page.evaluate(() => localStorage.getItem('planner-data') || '');
  const addTodo = async (title) => { await page.fill('.home-add input', title); await page.press('.home-add input', 'Enter'); };

  // 1) 평소엔 표시 없음
  await addTodo('정상 저장 확인');
  await page.waitForTimeout(500);
  check('정상 저장: 표시가 안 떠 있음(방해 없음)', (await st()).hidden === true, JSON.stringify(await st()));
  check('정상 저장: 실제로 저장됨', (await stored()).includes('정상 저장 확인'));

  // 2) 저장소 오류를 일부러 발생
  await page.evaluate(() => {
    window.__failWrites = true;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (window.__failWrites && k === 'planner-data') throw new DOMException('quota', 'QuotaExceededError'); return orig.call(this, k, v); };
  });
  await addTodo('저장 실패 상황');
  await page.waitForTimeout(400);
  const s1 = await st();
  check('저장 실패: 화면에 경고가 보임', !s1.hidden && s1.state === 'error' && s1.text.includes('저장 실패') && s1.text.includes('다시 시도'), JSON.stringify(s1));
  check('저장 실패: 스크린리더용 role=alert', s1.role === 'alert');
  check('저장 실패: 실제로는 저장 안 됨(경고가 맞음)', !(await stored()).includes('저장 실패 상황'));
  await page.screenshot({ path: S + '/shot3-saveerr.png' });

  // 3) 계속 실패해도 경고가 유지되고, "다시 시도" 눌러도 실패면 그대로
  await page.click('.save-retry');
  await page.waitForTimeout(300);
  check('재시도해도 실패면 경고 유지', (await st()).state === 'error');

  // 4) 문제 해결 후 "다시 시도" → 저장됨
  await page.evaluate(() => { window.__failWrites = false; });
  await page.click('.save-retry');
  await page.waitForTimeout(300);
  const s2 = await st();
  check('다시 시도 성공: "저장됨" 표시', s2.state === 'saved' && s2.text.includes('저장됨'), JSON.stringify(s2));
  check('다시 시도 성공: 실패했던 내용까지 저장됨', (await stored()).includes('저장 실패 상황'));
  await page.waitForTimeout(2100);
  check('"저장됨"은 잠깐 뒤 사라짐', (await st()).hidden === true);

  // 5) 자동 재시도(5초)
  await page.evaluate(() => { window.__failWrites = true; });
  await addTodo('자동 재시도 확인');
  await page.waitForTimeout(400);
  check('자동 재시도 준비: 경고 표시', (await st()).state === 'error');
  await page.evaluate(() => { window.__failWrites = false; });
  await page.waitForTimeout(5600);
  check('자동 재시도: 5초 안에 알아서 저장됨', (await stored()).includes('자동 재시도 확인') && (await st()).state !== 'error', JSON.stringify(await st()));

  // 6) 창을 닫기 직전 저장(pagehide)
  await addTodo('닫기 직전 저장');
  const flushed = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return (localStorage.getItem('planner-data') || '').includes('닫기 직전 저장');
  });
  check('창을 닫기 직전: 대기 중인 변경도 바로 저장', flushed === true);

  // 7) 통계 문구
  await page.waitForTimeout(300);
  await page.click('[data-nav="stats"]');
  const labels = await page.$$eval('.stat-tile .stat-label:first-child', (e) => e.map((x) => x.textContent));
  const note = await page.$eval('.stat-basis', (e) => e.textContent);
  check('통계: 두 지표 이름에 기준이 드러남', labels.some((t) => t.includes('체크한 날 기준')) && labels.some((t) => t.includes('기한 달성률')), JSON.stringify(labels));
  check('통계: 기준 안내 문장이 있음', note.includes('체크한 날') && note.includes('기한'));
  await page.screenshot({ path: S + '/shot3-stats.png' });
  check('데스크톱 콘솔/페이지 오류 없음', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // ======== 모바일 ========
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', hasTouch: true });
  const mp = await mctx.newPage();
  const merr = [];
  mp.on('pageerror', (e) => merr.push(e.message));
  await mp.goto(URL);
  await mp.waitForSelector('.home');
  await mp.waitForTimeout(300);
  const vis = (sel) => mp.$eval(sel, (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display !== 'none' && r.width > 0 && r.height > 0; });
  check('모바일: 검색·카테고리는 기본으로 접혀 있음', !(await vis('#searchBox')) && !(await vis('.side-cats')));
  check('모바일: ☰ 버튼이 보임', await vis('#sideToggle'));
  const topH = await mp.$eval('#sidebar', (e) => e.getBoundingClientRect().height);
  check('모바일: 위쪽 메뉴 영역이 낮음(80px 이하)', topH <= 80, Math.round(topH));
  const navBox = await mp.$eval('.nav-list', (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: Math.round(r.height), pos: getComputedStyle(e).position, vh: innerHeight }; });
  check('모바일: 메뉴가 화면 아래 고정 탭 바', navBox.pos === 'fixed' && navBox.bottom === navBox.vh && navBox.h <= 70, JSON.stringify(navBox));
  await mp.click('#sideToggle');
  check('모바일: ☰ 누르면 검색·카테고리가 펼쳐짐', (await vis('#searchBox')) && (await vis('.side-cats')));
  await mp.click('#sideToggle');
  check('모바일: 다시 누르면 접힘', !(await vis('#searchBox')));

  await mp.click('[data-nav="calendar"]');
  await mp.click('[data-view="month"]');
  await mp.waitForTimeout(200);
  const cells = await mp.$$eval('#calendar .cell.mini', (e) => e.length);
  check('모바일 월간: 칸에는 점만(칩 없음)', cells >= 35 && (await mp.$$eval('#calendar .month-grid .chip', (e) => e.length)) === 0, cells);
  check('모바일 월간: 오늘 칸이 선택돼 있고 아래에 목록이 있음', (await mp.$$eval('#calendar .cell.mini.sel.today', (e) => e.length)) === 1 && (await mp.$$eval('#calendar .agenda', (e) => e.length)) === 1);
  const headText = await mp.$eval('.agenda-head', (e) => e.textContent);
  check('모바일 월간: 목록 제목에 "오늘" 표시', headText.includes('오늘'), headText);
  // 일정이 있는 다른 날 고르기
  const idx = await mp.$$eval('#calendar .cell.mini', (cs) => cs.findIndex((c) => !c.classList.contains('today') && !c.classList.contains('other') && c.querySelector('.dot')));
  if (idx >= 0) {
    await mp.locator('#calendar .cell.mini').nth(idx).click();
    const selDate = await mp.$eval('#calendar .cell.mini.sel', (e) => e.dataset.date);
    const rows = await mp.$$eval('.agenda .chip', (e) => e.length);
    const headTxt = await mp.$eval('.agenda-head', (e) => e.textContent);
    check('모바일 월간: 날짜를 누르면 그날 일정 목록으로 바뀜', rows >= 1 && !headTxt.includes('오늘') && Number(selDate.slice(8)) === Number(headTxt.match(/(\d+)일/)[1]), `${selDate} · ${headTxt} · ${rows}개`);
    const cut = await mp.$$eval('.agenda .chip', (e) => e.filter((c) => c.scrollWidth > c.clientWidth + 1).length);
    check('모바일 월간: 목록의 일정 이름이 잘리지 않음', cut === 0, cut);
  } else check('모바일 월간: 일정 있는 날이 시드 데이터에 있음', false, 'no dot cell');
  await mp.screenshot({ path: S + '/shot3-m-month.png' });
  await mp.click('.agenda-add');
  await mp.waitForTimeout(200);
  check('모바일 월간: "+ 이 날 일정 추가"로 입력창이 열림', await mp.evaluate(() => !!document.querySelector('dialog[open]')));
  await mp.keyboard.press('Escape');

  const pages = ['home', 'calendar', 'todos', 'goals', 'stats', 'settings'];
  const bad = [];
  for (const p of pages) {
    await mp.click(`[data-nav="${p}"]`);
    await mp.waitForTimeout(80);
    const o = await mp.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, app: document.querySelector('.app').scrollWidth - document.querySelector('.app').clientWidth }));
    if (o.doc > 1 || o.app > 1) bad.push(p + JSON.stringify(o));
    await mp.screenshot({ path: `${S}/shot3-m-${p}.png` });
  }
  check('모바일: 모든 페이지 가로 넘침 없음', bad.length === 0, bad.join(','));
  // 탭 바가 내용을 가리지 않는지: 맨 아래까지 스크롤했을 때 마지막 요소가 탭 바 위에 있음
  await mp.click('[data-nav="settings"]');
  await mp.evaluate(() => { document.querySelector('.app').scrollTop = 1e6; });
  await mp.waitForTimeout(100);
  const lastClear = await mp.evaluate(() => {
    const nav = document.querySelector('.nav-list').getBoundingClientRect().top;
    const page = document.querySelector('.page:not([hidden]) .page-body');
    const kids = [...page.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 0);
    const maxBottom = Math.max(...kids.map((e) => e.getBoundingClientRect().bottom));
    return { nav: Math.round(nav), maxBottom: Math.round(maxBottom) };
  });
  check('모바일: 맨 아래 내용이 탭 바에 가려지지 않음', lastClear.maxBottom <= lastClear.nav + 1, JSON.stringify(lastClear));
  // 저장 실패 표시가 탭 바 위에 뜸
  await mp.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'planner-data') throw new Error('x'); return o.call(this, k, v); }; });
  await mp.click('[data-nav="home"]');
  await mp.fill('.home-add input', '모바일 저장 실패');
  await mp.press('.home-add input', 'Enter');
  await mp.waitForTimeout(400);
  const ov = await mp.evaluate(() => { const a = document.querySelector('#saveStatus').getBoundingClientRect(); const n = document.querySelector('.nav-list').getBoundingClientRect(); return { saveBottom: Math.round(a.bottom), navTop: Math.round(n.top), w: Math.round(a.width), vw: innerWidth }; });
  check('모바일: 저장 실패 표시가 탭 바를 가리지 않고 화면 안에 있음', ov.saveBottom <= ov.navTop && ov.w <= ov.vw, JSON.stringify(ov));
  await mp.screenshot({ path: S + '/shot3-m-saveerr.png' });
  check('모바일 오류 없음', merr.length === 0, merr.join(' / '));
  await mctx.close();

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
