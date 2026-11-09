const { chromium } = require('playwright');
const URL = 'file://' + __dirname + '/preview/index.html';
let seed = Number(process.argv[2] || 1);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL);
  await page.waitForSelector('.home');
  const sels = ['button', '.chip', '.cell', '.nav-item', '.mc-day', '.todo', '.sch', '.tg-dayhead', '.tg-col', '.goal-row', '.proj', '.cat-item', '.late-btn', '.hbar-row', 'summary', '[data-view]', '[data-nav]'];
  const keys = ['n', 'q', 't', 'm', 'w', 'd', 'ArrowLeft', 'ArrowRight', 'Escape', 'Control+z', 'Control+k', '/', 'Enter'];
  const words = ['', ' ', '가나다', '내일 3시 회의 #업무', '<b>x</b>', '😀'.repeat(5), 'a'.repeat(300), '12/31 종일', '"\'`', '0시', '99시 99분'];
  let n = 0;
  for (let i = 0; i < 900; i++) {
    const r = rnd();
    try {
      if (r < 0.62) {
        const loc = page.locator(pick(sels) + ':visible');
        const c = await loc.count();
        if (c) await loc.nth(Math.floor(rnd() * c)).click({ timeout: 400, force: rnd() < 0.2 });
      } else if (r < 0.78) {
        await page.keyboard.press(pick(keys));
      } else if (r < 0.9) {
        const loc = page.locator('input:visible:not([type=checkbox]):not([type=file]):not([type=color]):not([type=radio]), textarea:visible');
        const c = await loc.count();
        if (c) {
          const el = loc.nth(Math.floor(rnd() * c));
          const type = await el.getAttribute('type');
          if (type === 'date') await el.fill(pick(['2026-11-30', '2024-02-29', '2035-12-31']), { timeout: 400 });
          else if (type === 'time') await el.fill(pick(['00:00', '23:59', '12:30']), { timeout: 400 });
          else if (type === 'number') await el.fill(pick(['1', '0', '-3', '999']), { timeout: 400 });
          else await el.fill(pick(words), { timeout: 400 });
        }
      } else {
        const loc = page.locator('select:visible');
        const c = await loc.count();
        if (c) {
          const el = loc.nth(Math.floor(rnd() * c));
          const opts = await el.locator('option').evaluateAll((o) => o.map((x) => x.value));
          if (opts.length) await el.selectOption(pick(opts), { timeout: 400 });
        }
      }
      n++;
    } catch { /* 클릭 못 한 경우는 무시 */ }
    if (i % 60 === 0 && (await page.$('dialog[open]')) && rnd() < 0.5) await page.keyboard.press('Escape');
  }
  // 화면이 살아 있는지
  const alive = await page.evaluate(() => !!document.querySelector('.sidebar') && document.body.innerText.length > 50);
  console.log(`seed ${process.argv[2] || 1}: ${n} actions, alive=${alive}, errors=${errors.length}`);
  [...new Set(errors)].slice(0, 6).forEach((e) => console.log('  ', e.slice(0, 220)));
  await browser.close();
})();
