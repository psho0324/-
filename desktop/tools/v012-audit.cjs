// v0.1.2 user journeys against the real renderer and its production CSP.
// All data is synthetic and isolated in a fresh browser context per scenario.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../renderer');
const screenshots = path.resolve(__dirname, '../test-results/v012');
const fixedTime = '2026-11-12T12:00:00+09:00';
const today = '2026-11-12';
const blank = () => ({
  events: [],
  todos: [],
  projects: [],
  categories: [],
  goalRecords: [],
  goalDays: [],
  settings: { weekStart: 1, taskTrackingSince: '2026-01-01' }
});
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  const file = path.join(root, name);
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const type = name.endsWith('.js')
    ? 'text/javascript'
    : name.endsWith('.css')
      ? 'text/css'
      : 'text/html';
  res.setHeader('Content-Type', type + '; charset=utf-8');
  res.end(fs.readFileSync(file));
});
let browser,
  failures = 0,
  passes = 0;

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('planner-data')));
async function savedLength(page, key, length) {
  await page.waitForFunction(
    ({ key, length }) => {
      const data = JSON.parse(localStorage.getItem('planner-data'));
      return Array.isArray(data?.[key]) && data[key].length === length;
    },
    { key, length }
  );
}
async function nav(page, name) {
  await page.locator('[data-nav="' + name + '"]').click();
}
// Treat goal IDs as literal data rather than interpolating arbitrary IDs into selectors.
async function cardById(page, id) {
  const cards = page.locator('.habit-card');
  for (let index = 0; index < (await cards.count()); index++) {
    if ((await cards.nth(index).getAttribute('data-goal-id')) === id) return cards.nth(index);
  }
  throw new Error('Missing habit card: ' + id);
}
async function progress(card) {
  return Number(await card.locator('[role="progressbar"]').getAttribute('aria-valuenow'));
}
async function scenario(name, fixture, run, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: options.colorScheme || 'light'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript((fixture) => {
    if (!sessionStorage.getItem('v012-fixture-seeded')) {
      localStorage.setItem('planner-data', JSON.stringify(fixture));
      sessionStorage.setItem('v012-fixture-seeded', '1');
    }
  }, fixture);
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#homeBody .home').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'Uncaught renderer errors');
    passes++;
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, error.stack, JSON.stringify(errors));
    await page
      .screenshot({ path: path.join(screenshots, 'failure-' + failures + '.png') })
      .catch(() => {});
  } finally {
    await context.close();
  }
}

function habitFixture() {
  return {
    ...blank(),
    projects: [
      {
        id: 'daily',
        title: '매일 운동',
        mode: 'daily',
        activityId: 'exercise',
        startDate: '2026-11-01',
        due: '2026-11-30',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        status: 'active',
        memo: ''
      },
      {
        id: 'weekly',
        title: '이번 주 운동 5회',
        mode: 'count',
        activityId: 'exercise',
        startDate: '2026-11-01',
        due: '2026-11-30',
        period: 'week',
        target: 5,
        status: 'active',
        memo: ''
      }
    ],
    goalRecords: [
      { id: 'activity-1', activityId: 'exercise', date: '2026-11-09', createdAt: 1794193200000 },
      { id: 'activity-2', activityId: 'exercise', date: '2026-11-10', createdAt: 1794279600000 },
      { id: 'activity-3', activityId: 'exercise', date: '2026-11-11', createdAt: 1794366000000 }
    ]
  };
}

(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_EXECUTABLE ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox']
  });

  await scenario(
    'Manual themes override the OS, persist, and system mode follows changes',
    blank(),
    async (page) => {
      await nav(page, 'settings');
      assert.equal(await page.locator('#set-theme option').count(), 3);
      await page.locator('#set-theme').selectOption('dark');
      await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
      assert.equal(await page.locator('html').getAttribute('data-resolved-theme'), 'dark');
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('planner-data')).settings.theme === 'dark'
      );
      const darkBackground = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor
      );
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-resolved-theme'), 'dark');
      await nav(page, 'settings');
      await page.locator('#set-theme').selectOption('light');
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.equal(await page.locator('html').getAttribute('data-resolved-theme'), 'light');
      assert.notEqual(
        await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
        darkBackground
      );
      await page.locator('#set-theme').selectOption('system');
      await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === 'dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === 'light');
    }
  );

  await scenario(
    'Task creation is explicit, cancelling creates nothing, and priority is understandable',
    {
      ...blank(),
      categories: [{ id: 'study', name: '공부', color: '#3b82f6' }],
      settings: { ...blank().settings, hiddenCategories: ['study'] }
    },
    async (page) => {
      await nav(page, 'todos');
      assert.equal(await page.locator('#todoNew').getAttribute('type'), 'search');
      assert.equal(await page.locator('#td-proj').count(), 0);
      await page.locator('#todoNew').fill('현재 검색어');
      await page.locator('[data-filter="done"]').click();
      await page.locator('#todo-create').click();
      await page.locator('#td-title').fill('저장하면 안 되는 초안');
      await page.keyboard.press('Escape');
      assert.equal((await stored(page)).todos.length, 0);
      await page.locator('#todo-create').click();
      await page.locator('#todoForm button[type="submit"]').click();
      assert(await page.locator('#todoDialog').isVisible());
      assert(await page.locator('#td-error').isVisible());
      await page.locator('#td-title').fill('합성 과제 제출');
      await page.locator('#td-due').fill('2026-11-14');
      await page.locator('#td-prio').selectOption('2');
      await page.locator('#td-cat').selectOption('study');
      await page.locator('#td-memo').fill('원본 데이터 없는 검사용 메모');
      await page.locator('#todoForm button[type="submit"]').click();
      await savedLength(page, 'todos', 1);
      const task = (await stored(page)).todos[0];
      assert.equal(task.title, '합성 과제 제출');
      assert.equal(task.due, '2026-11-14');
      assert.equal(task.priority, 2);
      assert.equal(task.categoryId, 'study');
      assert.equal(task.memo, '원본 데이터 없는 검사용 메모');
      assert.equal(await page.locator('#todoNew').inputValue(), '');
      assert(!(await stored(page)).settings.hiddenCategories.includes('study'));
      assert.match(await page.locator('#todoList').innerText(), /높음/);
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      await nav(page, 'todos');
      assert.equal(await page.locator('#todoList .todo').count(), 1);
    }
  );

  await scenario(
    'Editing an old task preserves its existing goal relationship',
    {
      ...blank(),
      todos: [
        {
          id: 'old-task',
          title: '기존 할 일',
          projectId: 'old-goal',
          priority: 1,
          due: null,
          memo: ''
        }
      ],
      projects: [{ id: 'old-goal', title: '기존 일회성 목표', status: 'active', memo: '' }]
    },
    async (page) => {
      await nav(page, 'todos');
      await page.locator('.todo-title').click();
      await page.locator('#td-memo').fill('메모만 변경');
      await page.locator('#todoForm button[type="submit"]').click();
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('planner-data')).todos[0].memo === '메모만 변경'
      );
      assert.equal((await stored(page)).todos[0].projectId, 'old-goal');
      await nav(page, 'goals');
      assert.match(await page.locator('#projList').innerText(), /기존 일회성 목표/);
      await page.locator('.proj-head').click();
      await page.locator('#pj-memo').fill('기존 일회성 목표의 메모만 변경');
      await page.locator('#projForm button[type="submit"]').click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('planner-data')).projects[0].memo ===
          '기존 일회성 목표의 메모만 변경'
      );
      assert.equal((await stored(page)).projects[0].mode, undefined);
      assert(
        await page.locator('[data-padd]').isVisible(),
        'Existing linked-task entry remains available after editing a legacy goal'
      );
    }
  );

  await scenario(
    'Page search does not create data or silently filter another page',
    {
      ...blank(),
      todos: [
        { id: 't1', title: '찾을 할 일', due: null },
        { id: 't2', title: '다른 작업', due: null }
      ],
      projects: [
        { id: 'p1', title: '찾을 목표', status: 'active' },
        { id: 'p2', title: '다른 목표', status: 'active' }
      ]
    },
    async (page) => {
      await nav(page, 'todos');
      await page.locator('#todoNew').fill('찾을');
      assert.equal(await page.locator('#todoList .todo').count(), 1);
      await page.locator('#todoNew').press('Enter');
      assert.equal((await stored(page)).todos.length, 2);
      await nav(page, 'goals');
      assert.match(await page.locator('#projList').innerText(), /다른 목표/);
      await page.locator('#projNew').fill('찾을');
      assert.doesNotMatch(await page.locator('#projList').innerText(), /다른 목표/);
      await page.locator('#projNew').press('Enter');
      assert.equal((await stored(page)).projects.length, 2);
    }
  );

  await scenario(
    'Goal creation cancels cleanly, validates dates, and keeps the supplied details',
    blank(),
    async (page) => {
      await nav(page, 'goals');
      await page.locator('#projNew').fill('현재 검색어');
      await page.locator('[data-pfilter="done"]').click();
      await page.locator('#goal-create').click();
      await page.locator('#pj-title').fill('목표 초안');
      await page.locator('#pj-cancel').click();
      assert.equal((await stored(page)).projects.length, 0);
      await page.locator('#goal-create').click();
      await page.locator('#pj-title').fill('검사용 매일 독서');
      await page.locator('#pj-mode').selectOption('daily');
      await page.locator('#pj-start').fill('2026-11-20');
      await page.locator('#pj-due').fill('2026-11-10');
      await page.locator('#projForm button[type="submit"]').click();
      assert(await page.locator('#projDialog').isVisible());
      assert(await page.locator('#pj-error').isVisible());
      assert.equal((await stored(page)).projects.length, 0);
      await page.locator('#pj-start').fill(today);
      await page.locator('#pj-due').fill('2026-12-31');
      await page.locator('#pj-memo').fill('검사용 완료 기준');
      await page.locator('#projForm button[type="submit"]').click();
      await savedLength(page, 'projects', 1);
      const goal = (await stored(page)).projects[0];
      assert.equal(goal.mode, 'daily');
      assert.equal(goal.startDate, today);
      assert.equal(goal.due, '2026-12-31');
      assert.equal(goal.memo, '검사용 완료 기준');
      assert.equal(await page.locator('#projNew').inputValue(), '');
      assert.equal(await page.locator('.habit-card').count(), 1);
    }
  );

  await scenario(
    'Quick add preserves durations and point events through editing and reload',
    blank(),
    async (page) => {
      for (const text of [
        '9시 합성 수업 2시간 짜리',
        '9시 합성 시작',
        '23:00~01:00 합성 야간 수업'
      ]) {
        await page.locator('#quickOpen').click();
        await page.locator('#quickInput').fill(text);
        assert(!(await page.locator('#quickOk').isDisabled()));
        await page.locator('#quickOk').click();
      }
      await savedLength(page, 'events', 3);
      let events = (await stored(page)).events;
      assert.equal(events[0].start, today + 'T09:00');
      assert.equal(events[0].end, today + 'T11:00');
      assert.equal(events[0].title, '합성 수업');
      assert.equal(events[1].timeType, 'point');
      assert.equal(events[1].start, events[1].end);
      assert.equal(events[2].end, '2026-11-13T01:00');
      await nav(page, 'calendar');
      await page.locator('.chip', { hasText: '합성 시작' }).first().click();
      assert(await page.locator('#ev-point').isChecked());
      await page.locator('#ev-memo').fill('시각만 일정 유지');
      await page.locator('#eventForm button[type="submit"]').click();
      await page.waitForFunction(() =>
        JSON.parse(localStorage.getItem('planner-data')).events.some(
          (event) => event.memo === '시각만 일정 유지'
        )
      );
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      events = (await stored(page)).events;
      assert.equal(events[1].timeType, 'point');
      assert.equal(events[1].start, events[1].end);
      assert.equal(events[0].end, today + 'T11:00');
      await page.locator('#quickOpen').click();
      await page.locator('#quickInput').fill('9시~10시 모순 수업 2시간');
      assert(await page.locator('#quickOk').isDisabled());
      await page.locator('#quickInput').press('Enter');
      assert(await page.locator('#quickDialog').isVisible());
      assert.equal(await page.locator('#quickInput').inputValue(), '9시~10시 모순 수업 2시간');
      await page.locator('#quickInput').fill('23:00~01:00 모순 수업 1시간');
      assert(await page.locator('#quickOk').isDisabled());
      assert.equal((await stored(page)).events.length, 3);
    }
  );

  await scenario(
    'Daily and weekly count goals use separate progress bases and share one chosen record',
    habitFixture(),
    async (page) => {
      await nav(page, 'goals');
      let daily = await cardById(page, 'daily'),
        weekly = await cardById(page, 'weekly');
      assert.equal(await weekly.locator('[data-missed], [data-clear-day]').count(), 0);
      assert.equal(await progress(daily), 100, 'Three completed past days; today is still pending');
      assert.equal(
        await progress(weekly),
        60,
        'Three records out of the explicit weekly target of five'
      );
      await page.locator('#goal-range-month').click();
      daily = await cardById(page, 'daily');
      weekly = await cardById(page, 'weekly');
      assert.equal(await progress(daily), 27, 'Three complete out of eleven past scheduled days');
      assert.equal(await progress(weekly), 60, 'Viewing a month must not prorate a weekly target');
      await page.locator('#goal-range-week').click();
      daily = await cardById(page, 'daily');
      await daily.locator('.habit-record-date').fill(today);
      await daily.locator('button[data-record]').click();
      await savedLength(page, 'goalRecords', 4);
      assert.equal(
        (await stored(page)).goalRecords.filter((record) => record.date === today).length,
        1
      );
      assert.equal(await progress(await cardById(page, 'weekly')), 80);
      assert.equal(await progress(await cardById(page, 'daily')), 100);
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      await nav(page, 'goals');
      assert.equal(await progress(await cardById(page, 'weekly')), 80);
    }
  );

  await scenario(
    'Similar goals produce a nonblocking warning and stay independent unless explicitly linked',
    {
      ...blank(),
      projects: [habitFixture().projects[0]]
    },
    async (page) => {
      await nav(page, 'goals');
      await page.locator('#goal-create').click();
      await page.locator('#pj-mode').selectOption('count');
      await page.locator('#pj-period').selectOption('week');
      await page.locator('#pj-target').fill('3');
      await page.locator('#pj-title').fill('이번 주 운동 3회');
      await page.locator('#pj-similar').waitFor();
      assert.match(await page.locator('#pj-similar').innerText(), /매일 운동/);
      await page.locator('#pj-similar summary').first().click();
      assert.match(await page.locator('#pj-similar details').first().innerText(), /2026-11-01/);
      await page.locator('#projForm button[type="submit"]').click();
      await savedLength(page, 'projects', 2);
      let goals = (await stored(page)).projects;
      assert.notEqual(
        goals[0].activityId,
        goals[1].activityId,
        'A similar name must not silently share records'
      );
      await page.locator('#goal-create').click();
      await page.locator('#pj-mode').selectOption('count');
      await page.locator('#pj-title').fill('매달 운동 10회');
      await page.locator('#pj-period').selectOption('month');
      await page.locator('#pj-target').fill('10');
      const shared = await page
        .locator('#pj-share option')
        .evaluateAll((options) =>
          options
            .map((option) => ({ value: option.value, text: option.textContent }))
            .find((option) => option.text.includes('매일 운동'))
        );
      assert(shared, 'The existing activity is available only through an explicit choice');
      await page.locator('#pj-share').selectOption(shared.value);
      await page.locator('#projForm button[type="submit"]').click();
      await savedLength(page, 'projects', 3);
      goals = (await stored(page)).projects;
      assert.equal(goals[0].activityId, goals[2].activityId);
    }
  );

  await scenario(
    'Cancelling a shared record updates both goals and missed days remain explicit',
    habitFixture(),
    async (page) => {
      await nav(page, 'goals');
      let daily = await cardById(page, 'daily');
      await daily.locator('details.habit-records summary').click();
      await daily.locator('button[data-unrecord="activity-1"]').click();
      await savedLength(page, 'goalRecords', 2);
      assert.deepEqual((await stored(page)).goalRecords.map((record) => record.id).sort(), [
        'activity-2',
        'activity-3'
      ]);
      assert.equal(await progress(await cardById(page, 'weekly')), 40);
      assert.match(await page.locator('#goal-activity-summary').innerText(), /실천 2건/);
      daily = await cardById(page, 'daily');
      await daily.locator('.habit-record-date').fill('2026-11-09');
      await daily.locator('button[data-missed]').click();
      await savedLength(page, 'goalDays', 1);
      const missed = (await stored(page)).goalDays[0];
      assert.equal(missed.goalId, 'daily');
      assert.equal(missed.date, '2026-11-09');
      assert.equal(missed.status, 'missed');
      daily = await cardById(page, 'daily');
      assert(await daily.getByRole('button', { name: '2026-11-09 못함', exact: true }).isVisible());
      await daily.locator('.habit-record-date').fill('2026-11-09');
      await daily.locator('button[data-clear-day]').click();
      await savedLength(page, 'goalDays', 0);
      assert(
        await (await cardById(page, 'daily'))
          .getByRole('button', { name: '2026-11-09 미기록', exact: true })
          .isVisible()
      );
      assert.equal((await stored(page)).goalRecords.length, 2);
    }
  );

  await scenario(
    'Recurring targets and record dates refresh safely after midnight without reopening the app',
    habitFixture(),
    async (page) => {
      await nav(page, 'goals');
      await (await cardById(page, 'weekly')).locator('.habit-heading').click();
      assert(await page.locator('#pj-mode').isDisabled());
      await page.locator('#pj-target').fill('10');
      await page.locator('#projForm button[type="submit"]').click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('planner-data')).projects.find(
            (goal) => goal.id === 'weekly'
          )?.policyHistory?.length >= 2
      );
      assert.equal(await progress(await cardById(page, 'weekly')), 60);
      await page.clock.setFixedTime(new Date('2026-11-13T12:00:00+09:00'));
      await (await cardById(page, 'weekly')).locator('button[data-record]').click();
      assert.equal(
        await (await cardById(page, 'weekly')).locator('.habit-record-date').inputValue(),
        '2026-11-13'
      );
      assert.equal(
        (await stored(page)).goalRecords.length,
        3,
        'A stale pre-midnight card refreshes instead of recording the wrong date'
      );
      assert.equal(await progress(await cardById(page, 'weekly')), 30);
      await (await cardById(page, 'weekly')).locator('button[data-record]').click();
      await savedLength(page, 'goalRecords', 4);
      assert.equal(
        (await stored(page)).goalRecords.filter((record) => record.date === '2026-11-13').length,
        1
      );
      assert.equal(await progress(await cardById(page, 'weekly')), 40);
      await page.clock.setFixedTime(new Date('2026-11-14T12:00:00+09:00'));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const nextDay = (await cardById(page, 'daily')).locator('.habit-record-date');
      assert.equal(await nextDay.inputValue(), '2026-11-14');
      assert.equal(await nextDay.getAttribute('max'), '2026-11-14');
    }
  );

  await scenario(
    "A new goal explicitly shares today's activity even when another link is scheduled for tomorrow",
    (() => {
      const fixture = habitFixture();
      const Goals = require('../renderer/goals.js');
      fixture.projects = [
        Goals.revise(fixture.projects[0], { activityId: 'exercise-tomorrow' }, '2026-11-13')
      ];
      return fixture;
    })(),
    async (page) => {
      await nav(page, 'goals');
      await page.locator('#goal-create').click();
      await page.locator('#pj-mode').selectOption('count');
      await page.locator('#pj-title').fill('오늘 활동을 함께 세는 검사용 목표');
      await page.locator('#pj-period').selectOption('week');
      await page.locator('#pj-target').fill('3');
      const shared = await page
        .locator('#pj-share option')
        .evaluateAll((options) =>
          options
            .map((option) => ({ value: option.value, text: option.textContent }))
            .find((option) => option.text.includes('매일 운동'))
        );
      assert(shared);
      assert.equal(shared.value, 'exercise', 'The current policy defines the selectable activity');
      await page.locator('#pj-share').selectOption(shared.value);
      await page.locator('#projForm button[type="submit"]').click();
      await savedLength(page, 'projects', 2);
      const newGoal = (await stored(page)).projects[1];
      assert.equal(newGoal.activityId, 'exercise');
      await (await cardById(page, 'daily')).locator('button[data-record]').click();
      await savedLength(page, 'goalRecords', 4);
      assert.equal(
        (await stored(page)).goalRecords.filter((record) => record.date === today)[0].activityId,
        'exercise'
      );
      assert.equal(await progress(await cardById(page, newGoal.id)), 33);
    }
  );

  await scenario(
    'Backup export/import and undo retain activity records and explicit missed days',
    {
      ...habitFixture(),
      goalDays: [{ goalId: 'daily', date: '2026-11-08', status: 'missed' }]
    },
    async (page) => {
      await nav(page, 'settings');
      const downloaded = page.waitForEvent('download');
      await page.locator('#set-export').click();
      const download = await downloaded;
      assert.match(download.suggestedFilename(), /2026-11-12.*\.json$/);
      const original = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.equal(original.goalRecords.length, 3);
      assert.equal(original.goalDays[0].status, 'missed');
      const replacement = {
        ...blank(),
        app: '내 플래너',
        projects: [{ id: 'new', title: '교체 검사용 목표', status: 'active' }]
      };
      await page.locator('#set-importBox').fill(JSON.stringify(replacement));
      await page.locator('#set-import').click();
      await page.locator('#set-import').click();
      await savedLength(page, 'projects', 1);
      assert.equal((await stored(page)).goalRecords.length, 0);
      await page.locator('#set-undo').click();
      await savedLength(page, 'goalRecords', 3);
      assert.deepEqual((await stored(page)).goalDays, original.goalDays);
      await page.locator('#set-importBox').fill(JSON.stringify(original));
      await page.locator('#set-import').click();
      await page.locator('#set-import').click();
      await savedLength(page, 'goalRecords', 3);
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      assert.deepEqual((await stored(page)).goalDays, original.goalDays);
      assert.equal((await stored(page)).goalRecords.length, 3);
    }
  );

  await scenario(
    'Point markers stay at midnight and 23:59 without covering the preceding range',
    {
      ...blank(),
      settings: { ...blank().settings, defaultView: 'day' },
      events: [
        {
          id: 'point-midnight',
          title: '자정 시각',
          start: today + 'T00:00',
          end: today + 'T00:00',
          timeType: 'point',
          allDay: false
        },
        {
          id: 'point-late',
          title: '마지막 시각',
          start: today + 'T23:59',
          end: today + 'T23:59',
          timeType: 'point',
          allDay: false
        },
        {
          id: 'late-range',
          title: '앞선 기간 일정',
          start: today + 'T23:30',
          end: today + 'T23:50',
          allDay: false
        }
      ]
    },
    async (page) => {
      await nav(page, 'calendar');
      const midnight = page.locator('.tg-event.point-event[title="자정 시각"]');
      const late = page.locator('.tg-event.point-event[title="마지막 시각"]');
      const range = page.locator('.tg-event[title="앞선 기간 일정"]');
      assert.equal(await midnight.count(), 1);
      assert.equal(await late.count(), 1);
      assert.match(await midnight.locator('.time').innerText(), /00:00.*시각만/);
      assert.match(await late.locator('.time').innerText(), /23:59.*시각만/);
      const geometry = await page.locator('.tg-col').evaluate((column) => {
        const box = column.getBoundingClientRect();
        const rect = (title) => {
          const element = [...column.querySelectorAll('.tg-event')].find(
            (event) => event.title === title
          );
          const bounds = element.getBoundingClientRect();
          return {
            x: bounds.x,
            y: bounds.y,
            right: bounds.right,
            bottom: bounds.bottom,
            inlineTop: Number.parseFloat(element.style.top)
          };
        };
        return {
          column: { top: box.top, bottom: box.bottom, height: box.height },
          midnight: rect('자정 시각'),
          late: rect('마지막 시각'),
          range: rect('앞선 기간 일정')
        };
      });
      assert(Math.abs(geometry.midnight.y - geometry.column.top) <= 1);
      assert(
        Math.abs(geometry.late.inlineTop / geometry.column.height - 1439 / 1440) < 0.002,
        '23:59 keeps its real time coordinate'
      );
      assert(geometry.late.bottom <= geometry.column.bottom + 1);
      const overlapX =
        Math.min(geometry.late.right, geometry.range.right) -
        Math.max(geometry.late.x, geometry.range.x);
      const overlapY =
        Math.min(geometry.late.bottom, geometry.range.bottom) -
        Math.max(geometry.late.y, geometry.range.y);
      assert(
        !(overlapX > 1 && overlapY > 1),
        'The upward label at 23:59 must not hide an earlier range'
      );
      await page.locator('.tg-body').evaluate((body) => {
        body.scrollTop = 0;
      });
      await page.screenshot({ path: path.join(screenshots, 'point-midnight.png') });
      await late.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, 'point-2359.png') });
      const events = (await stored(page)).events;
      assert.equal(events.find((event) => event.id === 'point-late').start, today + 'T23:59');
      assert.equal(events.find((event) => event.id === 'point-late').end, today + 'T23:59');
    }
  );

  await scenario(
    'Editing a legacy zero-minute event preserves its start and end and leaves ranges intact',
    {
      ...blank(),
      events: [
        {
          id: 'legacy-zero',
          title: '기존 0분 일정',
          start: today + 'T10:00',
          end: today + 'T10:00',
          allDay: false,
          memo: ''
        },
        {
          id: 'legacy-hour',
          title: '기존 한 시간 일정',
          start: today + 'T11:00',
          end: today + 'T12:00',
          allDay: false
        }
      ]
    },
    async (page) => {
      await nav(page, 'calendar');
      await page.locator('.chip', { hasText: '기존 0분 일정' }).first().click();
      assert(await page.locator('#ev-point').isChecked());
      await page.locator('#ev-memo').fill('종료 시각을 늘리지 않는 편집');
      await page.locator('#eventForm button[type="submit"]').click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('planner-data')).events.find(
            (event) => event.id === 'legacy-zero'
          ).memo === '종료 시각을 늘리지 않는 편집'
      );
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      const events = (await stored(page)).events;
      assert.equal(events[0].start, today + 'T10:00');
      assert.equal(events[0].end, today + 'T10:00');
      assert.equal(events[0].timeType, 'point');
      assert.equal(events[1].start, today + 'T11:00');
      assert.equal(events[1].end, today + 'T12:00');
    }
  );

  await scenario(
    'Practice calendars align dates with weekday headers and retain the configured first weekday',
    habitFixture(),
    async (page) => {
      await nav(page, 'goals');
      let daily = await cardById(page, 'daily');
      assert.deepEqual(await daily.locator('.habit-week-labels span').allTextContents(), [
        '월',
        '화',
        '수',
        '목',
        '금',
        '토',
        '일'
      ]);
      assert.equal(await daily.locator('.habit-days > span').count(), 0);
      await page.locator('#goal-range-month').click();
      daily = await cardById(page, 'daily');
      assert.equal(
        await daily.locator('.habit-days > span').count(),
        6,
        'November 1, 2026 is Sunday'
      );
      const first = await daily.locator('.habit-days button').first().boundingBox();
      const sunday = await daily.locator('.habit-week-labels span').last().boundingBox();
      assert(first && sunday && Math.abs(first.x - sunday.x) < 1);
      await nav(page, 'settings');
      await page.locator('#set-weekStart').selectOption('0');
      await nav(page, 'goals');
      daily = await cardById(page, 'daily');
      assert.deepEqual(await daily.locator('.habit-week-labels span').allTextContents(), [
        '일',
        '월',
        '화',
        '수',
        '목',
        '금',
        '토'
      ]);
      assert.equal(await daily.locator('.habit-days > span').count(), 0);
    }
  );

  await scenario(
    'Malformed practice backup data is rejected without changing the existing planner',
    { ...habitFixture(), goalDays: [{ goalId: 'daily', date: '2026-11-08', status: 'missed' }] },
    async (page) => {
      await nav(page, 'settings');
      const original = await stored(page);
      const record = original.goalRecords[0];
      const invalidBackups = [
        { goalRecords: { bad: 'not an array' } },
        { goalRecords: [{ ...record, date: '2026-02-30' }] },
        { goalRecords: [record, { ...record }] },
        { goalDays: [{ goalId: 'daily', date: today, status: 'not-a-status' }] }
      ];
      for (const invalid of invalidBackups) {
        await page.locator('#set-importBox').fill(JSON.stringify({ ...blank(), ...invalid }));
        await page.locator('#set-import').click();
        await page.locator('#set-import').click();
        assert.match(await page.locator('#set-importMsg').getAttribute('class'), /err/);
        assert.deepEqual(
          await stored(page),
          original,
          'A rejected backup must not replace current data'
        );
      }
      await page.reload();
      await page.locator('#homeBody .home').waitFor();
      assert.deepEqual(await stored(page), original);
    }
  );

  await scenario(
    'Dark goals and creation dialogs remain usable at a 320px viewport',
    {
      ...habitFixture(),
      settings: { ...blank().settings, theme: 'dark' }
    },
    async (page) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await nav(page, 'goals');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      );
      await page.screenshot({ path: path.join(screenshots, 'goals-mobile-dark.png') });
      await page.locator('#goal-create').click();
      await page.locator('#pj-mode').selectOption('daily');
      await page.locator('#pj-title').fill('매일 읽기 연습을 진행하는 긴 제목의 검사용 목표');
      assert(await page.locator('#projForm button[type="submit"]').isVisible());
      assert(
        await page
          .locator('#projDialog')
          .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)
      );
      await page.screenshot({ path: path.join(screenshots, 'goal-dialog-mobile-dark.png') });
      const submit = page.locator('#projForm button[type="submit"]');
      await submit.scrollIntoViewIfNeeded();
      const box = await submit.boundingBox();
      assert(
        box && box.y >= 0 && box.y + box.height <= 800,
        'The save action can be scrolled fully into view'
      );
      await page.screenshot({ path: path.join(screenshots, 'goal-dialog-mobile-dark-bottom.png') });
      await page.locator('#pj-cancel').click();
      assert(!(await page.locator('#projDialog').isVisible()));
      assert.equal((await stored(page)).projects.length, 2);
    }
  );

  console.log(
    `v0.1.2 renderer journeys: ${passes} passed, ${failures} failed; isolated synthetic fixtures only.`
  );
  if (failures) process.exitCode = 1;
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  });
