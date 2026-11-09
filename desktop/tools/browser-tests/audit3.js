const { chromium } = require('playwright');
const URL = 'file://' + __dirname + '/preview/index.html';
require('fs').mkdirSync(__dirname + '/out', { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const rows = [];
  for (const scheme of ['light', 'dark']) {
    for (const w of [1440, 1100, 900, 760, 390]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, locale: 'ko-KR', colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(URL);
      await page.waitForSelector('.home');
      for (const nav of ['home', 'calendar', 'todos', 'goals', 'stats', 'settings']) {
        await page.click(`[data-nav="${nav}"]`);
        await page.waitForTimeout(60);
        const over = await page.evaluate(() => {
          const doc = document.documentElement;
          const page = document.querySelector('.page:not([hidden])');
          const bad = [];
          if (doc.scrollWidth > innerWidth + 1) bad.push(`문서 가로스크롤 +${doc.scrollWidth - innerWidth}`);
          if (page) for (const el of page.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.tg-scroll,.month-grid')) { bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} 오른쪽 +${Math.round(r.right - innerWidth)}`); break; }
          }
          return bad;
        });
        if (over.length) rows.push(`${scheme} ${w}px ${nav}: ${over.join(', ')}`);
        if ((scheme === 'dark' && w === 1100) || (scheme === 'light' && w === 390)) await page.screenshot({ path: `${__dirname}/out/a3-${scheme}-${w}-${nav}.png` });
      }
      await ctx.close();
    }
  }
  console.log(rows.length ? rows.join('\n') : '모든 화면·폭에서 넘침 없음');
  await browser.close();
})();
