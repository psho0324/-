// 설치 앱처럼 window.storage(느린 디스크)를 흉내 내서, 종료 직전 "저장 끝날 때까지 기다리기"가 맞는지 점검
const { chromium } = require('playwright');
const S = require('path').join(__dirname, 'out'); // 스크린샷이 저장되는 폴더
require('fs').mkdirSync(S, { recursive: true });
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  -> ' + extra : '')); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await ctx.addInitScript(() => {
    window.__disk = null; window.__saves = 0; window.__delay = 600; window.__fail = false; window.__flushCb = null;
    window.storage = {
      load: async () => (window.__disk ? JSON.parse(JSON.stringify(window.__disk)) : {}),
      save: async (d) => {
        await new Promise((r) => setTimeout(r, window.__delay));
        if (window.__fail) throw new Error('디스크 오류');
        window.__disk = JSON.parse(JSON.stringify(d)); window.__saves++; return true;
      },
      onFlushRequest: (cb) => { window.__flushCb = cb; },
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + __dirname + '/preview/index.html');
  await page.waitForSelector('.home');
  await page.waitForTimeout(600);
  const add = async (t) => { await page.fill('.home-add input', t); await page.press('.home-add input', 'Enter'); };
  const has = (t) => page.evaluate((x) => !!window.__disk && JSON.stringify(window.__disk).includes(x), t);
  const flushNow = () => page.evaluate(async () => { const t0 = performance.now(); const ok = await window.__flushCb(); return { ok, ms: Math.round(performance.now() - t0) }; });

  check('앱이 종료 확인 요청을 받을 준비가 되어 있음', await page.evaluate(() => typeof window.__flushCb === 'function'));

  // 1) 방금 한 변경(아직 저장 대기 중) → 종료 확인이 저장 끝까지 기다림
  await add('종료 직전 변경');
  let r = await flushNow();
  check('종료 확인: 저장이 끝난 뒤에 true로 답함', r.ok === true && r.ms >= 500, JSON.stringify(r));
  check('종료 확인 뒤 디스크에 변경이 들어 있음', await has('종료 직전 변경'));

  // 2) 저장 도중에 또 바꾼 내용도 함께 저장
  await add('A 저장 도중');
  await page.waitForTimeout(250);          // A가 디스크에 쓰이는 중
  await add('B 그 사이 추가');
  r = await flushNow();
  check('저장 도중 추가한 변경도 모두 저장됨', r.ok === true && (await has('A 저장 도중')) && (await has('B 그 사이 추가')), JSON.stringify(r));

  // 3) 저장할 게 없으면 바로 true
  r = await flushNow();
  check('저장할 게 없으면 바로 true', r.ok === true && r.ms < 200, JSON.stringify(r));

  // 4) 디스크 오류 → false + 경고 표시, 해결 후 다시 확인하면 true
  await page.evaluate(() => { window.__fail = true; });
  await add('C 실패 상황');
  r = await flushNow();
  check('디스크 오류: 종료 확인이 false로 답함', r.ok === false, JSON.stringify(r));
  check('디스크 오류: 화면에 저장 실패 표시', await page.$eval('#saveStatus', (e) => !e.hidden && e.dataset.state === 'error'));
  await page.evaluate(() => { window.__fail = false; });
  r = await flushNow();
  check('오류 해결 뒤 다시 확인하면 true + 내용 저장됨', r.ok === true && (await has('C 실패 상황')), JSON.stringify(r));

  check('오류 없음', errors.length === 0, errors.join(' / '));
  await browser.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
