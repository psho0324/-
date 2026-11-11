// Actual renderer/CSP regression checks with isolated synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../renderer');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(path.join(root, name))) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(root, name)));
});
const blank = () => ({ events: [], todos: [], projects: [], categories: [], settings: { taskTrackingSince: '2026-01-01' } });
let browser, failures = 0;
async function scenario(name, fixture, run, native = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({fixture, native}) => {
    window.__persisted = fixture;
    if (native) {
      window.plannerApp = { getVersion: async () => '0.1.1' };
      window.storage = {
        load: async () => fixture,
        save: async value => { window.__persisted = value; return true; },
        info: async () => ({ dataFile: 'fixture/planner-data.json' }),
        listBackups: async () => [{ name: 'backup.json', date: '2026-11-11', time: '120000', counts: {events: 0, todos: 0, projects: 0} }],
        openFolder: async () => 'Synthetic shell failure',
        openBackupFolder: async () => { throw Error('Synthetic shell failure'); },
        backupNow: async () => { throw Error('Synthetic backup failure'); },
        chooseFolder: async () => { throw Error('Synthetic folder failure'); },
        resetFolder: async () => { throw Error('Synthetic reset failure'); },
        restoreBackup: async () => { throw Error('Synthetic restore failure'); },
        onExternalChange: () => {},
      };
    } else localStorage.setItem('planner-data', JSON.stringify(fixture));
  }, {fixture, native});
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForSelector('#homeBody .home', {timeout: 4000});
    await run(page);
    assert.deepEqual(errors, [], 'Uncaught renderer errors');
    console.log('PASS', name);
  } catch (error) { failures++; console.error('FAIL', name, error.message, JSON.stringify(errors)); }
  finally { await ctx.close(); }
}
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  await scenario('Malformed settings do not prevent startup/calendar/import', {
    ...blank(), settings: { hiddenCategories: 'not-an-array', weekStart: 99, taskTrackingSince: {} },
  }, async page => {
    await page.locator('[data-nav="calendar"]').click();
    assert.equal(await page.locator('.cell').count(), 42);
    await page.locator('[data-nav="settings"]').click();
    await page.locator('#set-importBox').fill(JSON.stringify({...blank(), settings: { hiddenCategories: 7, weekStart: 'bad' }}));
    await page.locator('#set-import').click(); await page.locator('#set-import').click();
    await page.locator('[data-nav="calendar"]').click();
    assert.equal(await page.locator('.cell').count(), 42);
  });
  await scenario('Malformed memo remains editable and searchable', {
    ...blank(), todos: [{id:'t1', title:'Synthetic task', memo:{bad:true}, due:null}],
    projects:[{id:'p1',title:'Synthetic goal',memo:['bad']}],
    events:[{id:'e1',title:'Synthetic event',memo:17,start:'2026-11-11T10:00',end:'2026-11-11T11:00'}],
  }, async page => {
    await page.locator('[data-nav="todos"]').click();
    await page.locator('#searchBox').fill('not present');
    assert.equal(await page.locator('#todoList .todo').count(), 0);
    await page.locator('[data-nav="goals"]').click();
    await page.locator('[data-nav="calendar"]').click();
  });
  await scenario('Imported goal IDs are treated as data, not CSS selectors', {
    ...blank(), projects:[{id:'goal-"quoted]',title:'Synthetic goal',status:'active'}],
  }, async page => {
    await page.locator('[data-nav="goals"]').click();
    await page.locator('[data-padd]').fill('Synthetic linked task');
    await page.locator('[data-padd]').press('Enter');
    assert.equal(await page.locator('.mini-title').textContent(), 'Synthetic linked task');
    assert(await page.locator('[data-padd]').evaluate(el => el === document.activeElement));
  });
  await scenario('Editing completed event date preserves its completion', {
    ...blank(), events:[{id:'e1',title:'Completed synthetic event',start:'2026-11-11T10:00',end:'2026-11-11T11:00',repeat:'none',doneOn:{'2026-11-11':1794355200000}}],
  }, async page => {
    await page.locator('[data-nav="calendar"]').click();
    await page.locator('#dp-year').selectOption('2026'); await page.locator('#dp-month').selectOption('10');
    await page.locator('.chip', {hasText:'Completed synthetic event'}).first().click();
    await page.locator('#ev-start-date').fill('2026-11-12'); await page.locator('#ev-start-date').dispatchEvent('change');
    await page.locator('#eventForm button[type="submit"]').click();
    assert(await page.locator('.chip.done', {hasText:'Completed synthetic event'}).count());
  });
  await scenario('Invalid quick-add dates keep the input and block creation', blank(), async page => {
    await page.locator('#quickOpen').click();
    await page.locator('#quickInput').fill('2026-02-30 오후 3시 Synthetic event');
    assert(await page.locator('#quickOk').isDisabled());
    assert((await page.locator('#quickPreview').textContent()).includes('확인'));
    await page.locator('#quickInput').press('Enter');
    assert(await page.locator('#quickDialog').isVisible());
    assert.equal(await page.locator('#quickInput').inputValue(), '2026-02-30 오후 3시 Synthetic event');
  });
  await scenario('Legacy event completion without timestamp is excluded from checked-day statistics', {
    ...blank(), events:[{id:'legacy',title:'Synthetic legacy completion',start:'2026-11-11T10:00',end:'2026-11-11T11:00',doneOn:{'2026-11-11':true}}],
  }, async page => {
    await page.locator('[data-nav="stats"]').click();
    await page.locator('[data-stat="month"]').click();
    assert.equal(await page.locator('.stats-tiles .stat-num').first().textContent(), '0');
  });
  await scenario('Goals fit a 320px screen', {...blank(), projects:[{id:'p1',title:'Synthetic narrow goal'}]}, async page => {
    await page.setViewportSize({width:320,height:800});
    await page.locator('[data-nav="goals"]').click();
    assert(await page.locator('#projList').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  });
  for (const width of [390, 320]) for (const colorScheme of ['light', 'dark']) {
    await scenario(`Settings controls stay beside their labels at ${width}px ${colorScheme}`, blank(), async page => {
      await page.setViewportSize({width, height: 850});
      await page.emulateMedia({colorScheme});
      await page.locator('[data-nav="settings"]').click();
      for (const id of ['set-weekStart', 'set-holidays', 'set-notify', 'set-keep', 'set-autostart', 'app-version']) {
        const layout = await page.locator('#' + id).evaluate(control => {
          const row = control.closest('.set-row'), label = row.firstElementChild;
          const a = label.getBoundingClientRect(), b = control.getBoundingClientRect(), r = row.getBoundingClientRect();
          return {direction: getComputedStyle(row).flexDirection, labelRight: a.right, controlLeft: b.left,
            controlRight: b.right, rowRight: r.right, centers: Math.abs(a.y + a.height / 2 - b.y - b.height / 2)};
        });
        assert.equal(layout.direction, 'row', id + ' moved under its label');
        assert(layout.controlLeft >= layout.labelRight - 1, id + ' overlaps its label');
        assert(layout.controlRight <= layout.rowRight + 1, id + ' overflows its row');
        assert(layout.centers <= 1, id + ' is not vertically centered');
      }
      assert(await page.locator('#page-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Settings overflow horizontally');
      const out = path.resolve(__dirname, '../test-results/review-settings');
      fs.mkdirSync(out, {recursive: true});
      await page.screenshot({path: path.join(out, `settings-${width}-${colorScheme}.png`), fullPage: true});
    }, true);
  }
  await scenario('Rejected native backup/folder/restore calls show recoverable feedback', blank(), async page => {
    await page.locator('[data-nav="settings"]').click();
    await page.locator('#set-folderOpen').click();
    await page.waitForFunction(() => document.querySelector('#set-folderMsg').textContent.includes('열지 못했어요'));
    await page.locator('#set-backupOpen').click();
    await page.waitForFunction(() => document.querySelector('#set-backupMsg').textContent.includes('열지 못했어요'));
    await page.locator('#set-backupNow').click();
    await page.waitForFunction(() => document.querySelector('#set-backupMsg').classList.contains('err'));
    await page.locator('#set-folder').click();
    await page.waitForFunction(() => document.querySelector('#set-folderMsg').classList.contains('err'));
    assert.match(await page.locator('#set-folderMsg').textContent(), /최근 변경을 보호[\s\S]*다시 시도[\s\S]*내보내/);
    const restore = page.locator('.bk-row button');
    await restore.click(); await restore.click();
    await page.waitForFunction(() => document.querySelector('#set-backupMsg').textContent.includes('복원'));
    assert(!(await page.locator('#set-backupNow').isDisabled()));
    assert(!(await page.locator('#set-folder').isDisabled()));
  }, true);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await new Promise(r => server.close(r));
});
