// These journeys run against both source Electron and the installed Windows app.
// Writes stay in the smoke test's isolated native JSON store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function nativeFeatures(ctx) {
  const { getApp, restart, dataFile, userData, output, record, until, report } = ctx;
  let page = ctx.page;
  const persisted = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const load = () => page.evaluate(() => window.storage.load());
  const field = name => page.locator('#' + name);
  await getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  // Playwright otherwise emulates light even when Electron nativeTheme is dark.
  await page.emulateMedia({ colorScheme: null });
  const originalTheme = await getApp().evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  });
  async function theme(value, resolved) {
    await field('set-theme').selectOption(value);
    await page.waitForFunction(({value,resolved}) => document.documentElement.dataset.theme === value && document.documentElement.dataset.resolvedTheme === resolved, {value,resolved});
  }
  try {
    await page.locator('[data-nav="settings"]').click();
    const account = await page.evaluate(() => window.plannerAccount.getState());
    assert.equal(account.auth.authenticated, false);
    const expectedConfig = !!require('../account-service.js').validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../account-config.json'), 'utf8')));
    assert.equal(account.auth.configured, expectedConfig);
    assert(!JSON.stringify(account).includes('access_token'));
    await page.locator('#account-status').waitFor({ state: 'visible' });
    if (!expectedConfig) {
      assert.match(await page.locator('#account-status').innerText(), /준비 중/);
      assert.equal(await page.locator('#account-google').isEnabled(), false);
    }
    await page.screenshot({ path: path.join(output, 'native-account-settings.png'), fullPage: true });
    record('Native account: optional configured/unconfigured sync leaves guest offline use and credentials isolated');
    report.installedChecklist.accountSync = 'Native account IPC/UI and packaged public configuration verified as guest; live provider and two-device Internet sync require separate setup/verification.';
    await getApp().evaluate(({nativeTheme}) => { nativeTheme.themeSource = 'light'; });
    await theme('dark', 'dark');
    await getApp().evaluate(({nativeTheme}) => { nativeTheme.themeSource = 'dark'; });
    await theme('light', 'light');
    await theme('system', 'dark');
    await getApp().evaluate(({nativeTheme}) => { nativeTheme.themeSource = 'light'; });
    await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === 'light');
    await theme('dark', 'dark');
    await until(() => persisted().settings.theme === 'dark', 'Native theme preference was not saved');
    record('Native feature: light/dark override and system mode follow real Electron nativeTheme');
    report.installedChecklist.themes = 'Verified light/dark/system, nativeTheme changes and native saved preference.';
  } finally {
    await getApp().evaluate(({nativeTheme}, value) => { nativeTheme.themeSource = value; }, originalTheme);
  }

  async function quick(text) {
    await field('quickOpen').click();
    await field('quickInput').fill(text);
    assert(await field('quickOk').isEnabled(), await field('quickPreview').innerText());
    await field('quickOk').click();
    await field('quickDialog').waitFor({state:'hidden'});
  }
  await quick('09:00 NATIVE point event');
  await quick('23:00 NATIVE duration event 2시간 짜리');
  await until(() => persisted().events.some(e => e.title === 'NATIVE duration event'), 'Native time fixtures were not saved');
  const point = persisted().events.find(e => e.title === 'NATIVE point event');
  const range = persisted().events.find(e => e.title === 'NATIVE duration event');
  assert(point); assert(range);
  assert.equal(point.timeType, 'point'); assert.equal(point.start, point.end);
  assert.equal(point.start, today + 'T09:00'); assert.equal(range.timeType, 'range');
  assert.equal(new Date(range.end) - new Date(range.start), 2 * 60 * 60 * 1000);
  await page.locator('[data-nav="calendar"]').click();
  await page.locator('[data-view="month"]').click();
  await page.locator('.chip').filter({hasText:'NATIVE point event'}).first().click();
  assert(await field('ev-point').isChecked());
  assert(!(await field('ev-end-row').isVisible()));
  await field('ev-title').fill('NATIVE point event edited');
  await page.locator('#eventForm button[type=submit]').click();
  record('Native feature: quick-add duration, midnight crossing and point editing retain exact time types');
  report.installedChecklist.pointEvents = 'Verified real quick-add, point editor and native start/end storage, including a two-hour midnight range.';

  async function createGoal(title, mode, share = '', period = 'week') {
    await page.locator('[data-nav="goals"]').click();
    await field('projNew').fill('');
    await field('goal-create').click();
    await field('pj-title').fill(title);
    await field('pj-mode').selectOption(mode);
    await field('pj-start').fill(today);
    if (mode === 'count') {
      await field('pj-period').selectOption(period);
      await field('pj-target').fill('3');
    }
    if (share) await field('pj-share').selectOption(share);
    await page.locator('#projForm button[type=submit]').click();
    await field('projDialog').waitFor({state:'hidden'});
    await until(() => persisted().projects.some(p => p.title === title), 'Native recurring goal was not saved');
    return (await load()).projects.find(p => p.title === title);
  }
  const daily = await createGoal('NATIVE daily practice', 'daily');
  const count = await createGoal('NATIVE weekly practice', 'count', daily.id);
  const monthly = await createGoal('NATIVE monthly practice', 'count', daily.id, 'month');
  const missed = await createGoal('NATIVE missed practice', 'daily');
  const card = id => page.locator('.habit-card').filter({has:page.locator(`[data-record="${id}"]`)});
  const rate = id => card(id).locator('[role="progressbar"]').getAttribute('aria-valuenow');
  await card(daily.id).locator('[data-record]').click();
  assert.equal(await rate(daily.id), '100'); assert.equal(await rate(count.id), '33'); assert.equal(await rate(monthly.id), '33');
  await card(count.id).locator('[data-record]').click();
  assert.equal(await rate(daily.id), '100'); assert.equal(await rate(count.id), '67'); assert.equal(await rate(monthly.id), '67');
  await card(count.id).locator('.habit-records summary').click();
  await card(count.id).locator('[data-unrecord]').first().click();
  assert.equal(await rate(daily.id), '100'); assert.equal(await rate(count.id), '33'); assert.equal(await rate(monthly.id), '33');
  await card(missed.id).locator('[data-missed]').click();
  await until(() => persisted().goalRecords?.length === 1 && persisted().goalDays?.some(d => d.goalId === missed.id && d.status === 'missed'), 'Native practice and missed-day records were not saved');
  const snapshot = persisted();
  assert.equal(snapshot.goalRecords[0].activityId, daily.id);
  assert.equal(snapshot.projects.find(p => p.id === count.id).activityId, daily.id);
  record('Native feature: daily/count progress, explicit sharing, record cancellation and missed-day persistence');
  report.installedChecklist.recurringGoals = 'Verified daily 100%, weekly/monthly 1/3 (33%), two records 2/3 (67%), sharing/cancellation and native missed-day state.';
  await page.screenshot({path:path.join(output, 'native-recurring-goals.png')});

  page = await restart();
  const restored = await load();
  assert.equal(restored.settings.theme, 'dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.deepEqual(restored.goalRecords, snapshot.goalRecords);
  assert.deepEqual(restored.goalDays, snapshot.goalDays);
  const restoredPoint = restored.events.find(e => e.id === point.id);
  assert.equal(restoredPoint.title, 'NATIVE point event edited');
  assert.equal(restoredPoint.timeType, 'point'); assert.equal(restoredPoint.start, restoredPoint.end);
  assert.deepEqual(restored.events.find(e => e.id === range.id), range);
  await page.locator('[data-nav="goals"]').click();
  assert.equal(await rate(daily.id), '100'); assert.equal(await rate(count.id), '33'); assert.equal(await rate(monthly.id), '33');
  record('Native feature: full quit/relaunch retains theme, point/range events and recurring goal history');
  await page.evaluate(() => window.storage.backupNow());
  const backups = fs.readdirSync(path.join(userData, 'backups')).filter(name => name.endsWith('.json'));
  assert(backups.some(name => {
    const backup = JSON.parse(fs.readFileSync(path.join(userData, 'backups', name), 'utf8'));
    return backup.goalRecords?.some(r => r.id === snapshot.goalRecords[0].id) && backup.goalDays?.some(d => d.goalId === missed.id);
  }), 'Native backup omitted new practice records or missed-day history');
  record('Native feature: actual native backup contains activity records and explicit missed days');
  report.installedChecklist.practiceBackup = 'Verified native backup contains the shared practice record and explicit missed-day history.';
  return page;
};
