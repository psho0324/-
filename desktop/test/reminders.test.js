// Offline scheduling logic and durable dedupe, without Electron/OS/network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReminderScheduler } = require('../reminders.js');
const minute = 60000;
const local = (hour = 10, minute = 0, day = 13, month = 10) => new Date(2026, month, day, hour, minute).getTime();
const dateString = value => {
  const d = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const event = (id = 'event', at = local(), extra = {}) => ({
  id, title: 'Synthetic offline reminder', start: dateString(at), end: dateString(at + 60*minute),
  repeat: 'none', reminder: 0, ...extra,
});
function fixture(options = {}) {
  let clock = options.clock ?? local();
  const data = options.data || { events: [event()], settings: {} };
  const saved = options.saved || { value: null };
  const notices = [], errors = [];
  const scheduler = createReminderScheduler({
    getData: () => data, now: () => clock,
    readState: () => saved.value,
    writeState: value => { saved.value = JSON.parse(JSON.stringify(value)); },
    notify: (notice, hooks) => {
      const record = { notice, hooks, closed: 0 }; notices.push(record);
      if (options.throwDisplay) throw Error('synthetic OS display failure');
      if (options.autoShow !== false) hooks.shown();
      return () => { record.closed++; hooks.closed(); };
    },
    onError: error => errors.push(error), ...options.overrides,
  });
  return { scheduler, data, saved, notices, errors, setTime: value => { clock = value; } };
}
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS', name); }

test('A local point event displays without an account or network client', () => {
  const f = fixture({data:{events:[event('point', local(), {timeType:'point', end:dateString(local())})],settings:{}}});
  const result = f.scheduler.tick();
  assert.equal(result.dispatched,1); assert.equal(f.notices[0].notice.kind,'reminder');
  assert.equal(f.notices[0].notice.start.getTime(),local()); assert.match(f.notices[0].notice.body,/시작/);
});
test('Future reminders stay silent until their exact local trigger', () => {
  const f = fixture({clock:local(9,59)}); f.scheduler.tick(); assert.equal(f.notices.length,0);
  f.setTime(local()); f.scheduler.tick(); assert.equal(f.notices.length,1);
});
test('A multi-day lead time queries shifted occurrence dates beyond 24 hours', () => {
  const f = fixture({data:{events:[event('advance',local(10,0,16),{reminder:3*24*60})],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,1); assert.equal(f.notices[0].notice.reminder,4320);
});
test('Repeated polling and process restart do not repeat a shown notification', () => {
  const f = fixture(); f.scheduler.tick(); f.scheduler.tick(); assert.equal(f.notices.length,1);
  const next = fixture({saved:f.saved}); next.scheduler.tick(); assert.equal(next.notices.length,0);
});
test('An unacknowledged OS notification is not recorded as shown', () => {
  const f = fixture({autoShow:false}); f.scheduler.tick(); f.scheduler.tick();
  assert.equal(f.notices.length,1); assert.equal(f.saved.value,null); assert.equal(f.scheduler.getState().pending,1);
  f.notices[0].hooks.shown(); assert.equal(f.saved.value.shown.length,1);
});
test('A failed OS notification can retry while still within the catch-up window', () => {
  const f = fixture({autoShow:false}); f.scheduler.tick(); f.notices[0].hooks.failed('synthetic failure');
  assert.equal(f.saved.value,null); f.scheduler.tick(); assert.equal(f.notices.length,2);
  f.notices[1].hooks.shown(); assert.equal(f.saved.value.shown.length,1);
});
test('A synchronous display exception does not stop another due event', () => {
  const f = fixture({throwDisplay:true,data:{events:[event('one'),event('two')],settings:{}}});
  const result=f.scheduler.tick(); assert.equal(result.errors,2); assert.equal(f.notices.length,2); assert.equal(f.scheduler.getState().pending,0);
});
test('A failure reported after show preserves durable dedupe', () => {
  const f=fixture(); f.scheduler.tick(); f.notices[0].hooks.failed('late OS error'); f.scheduler.tick(); assert.equal(f.notices.length,1);
});
test('Pending notifications time out and retry instead of remaining stuck forever', () => {
  const f=fixture({autoShow:false}); f.scheduler.tick(); f.setTime(local(10,2)); f.scheduler.tick();
  assert.equal(f.notices.length,2); assert.equal(f.notices[0].closed,1);
  f.notices[0].hooks.shown(); assert.equal(f.saved.value,null,'late show from cancelled request must be ignored');
});
test('Disabled notification preferences block display and do not consume reminders', () => {
  const f=fixture(); f.data.settings.notifications=false; assert.equal(f.scheduler.tick().enabled,false); assert.equal(f.notices.length,0);
  f.data.settings.notifications=true; f.scheduler.tick(); assert.equal(f.notices.length,1);
});
test('Disabling notifications closes an active pending notification', () => {
  const f=fixture({autoShow:false}); f.scheduler.tick(); f.data.settings.notifications=false; f.scheduler.tick();
  assert.equal(f.notices[0].closed,1); assert.equal(f.scheduler.getState().pending,0);
});
test('Deleted events cancel pending notification handles', () => {
  const f=fixture({autoShow:false}); f.scheduler.tick(); f.data.events=[]; f.scheduler.tick();
  assert.equal(f.notices[0].closed,1); f.notices[0].hooks.shown(); assert.equal(f.saved.value,null);
});
test('Moving an event cancels its old pending trigger and later displays its new time', () => {
  const f=fixture({autoShow:false}); f.scheduler.tick();
  f.data.events[0].start=dateString(local(11)); f.data.events[0].end=dateString(local(12)); f.scheduler.tick();
  assert.equal(f.notices[0].closed,1); assert.equal(f.notices.length,1);
  f.setTime(local(11)); f.scheduler.tick(); assert.equal(f.notices.length,2);
});
test('Changing the reminder offset invalidates the previous pending schedule', () => {
  const f=fixture({autoShow:false}); f.scheduler.tick(); f.data.events[0].reminder=5; f.scheduler.tick();
  assert.equal(f.notices[0].closed,1); assert.equal(f.notices.length,2);
  assert.equal(f.notices[1].notice.alertAt.getTime(),local(9,55));
});
test('Sleep catch-up includes the original missed reminder time', () => {
  const f=fixture({clock:local(9,50)}); f.scheduler.tick(); f.setTime(local(10,8)); f.scheduler.tick();
  assert.equal(f.notices.length,1); assert.equal(f.notices[0].notice.missed,true); assert.match(f.notices[0].notice.body,/놓친 알림.*10:00/);
});
test('Reminders older than 15 minutes are not flooded on startup', () => {
  const f=fixture({clock:local(10,16)}); const result=f.scheduler.tick(); assert.equal(result.dispatched,0);
});
test('A large due set becomes two notices plus one summary and is acknowledged together', () => {
  const f=fixture({data:{events:Array.from({length:12},(_,i)=>event('e'+i,local(9,55))),settings:{}}});
  const result=f.scheduler.tick(); assert.equal(result.dispatched,3); assert.equal(result.summaryItems,10);
  assert.equal(f.notices[2].notice.kind,'summary'); assert.equal(f.notices[2].notice.items.length,10);
  assert.match(f.notices[2].notice.body,/9:55|09:55/); assert.equal(f.saved.value.shown.length,12);
  f.scheduler.tick(); assert.equal(f.notices.length,3);
});
test('A failed summary leaves every member available for retry', () => {
  const f=fixture({autoShow:false,data:{events:[event('a'),event('b'),event('c')],settings:{}},overrides:{maxPerTick:1}});
  f.scheduler.tick(); assert.equal(f.notices.length,1); assert.equal(f.notices[0].notice.kind,'summary');
  f.notices[0].hooks.failed('synthetic failure'); f.scheduler.tick(); assert.equal(f.notices.length,2);
  f.notices[1].hooks.shown(); assert.equal(f.saved.value.shown.length,3);
});
test('Daily repetition respects exception dates', () => {
  const f=fixture({data:{events:[event('daily',local(10,0,12),{repeat:'daily',exceptions:['2026-11-13']})],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,0); f.setTime(local(10,0,14)); f.scheduler.tick(); assert.equal(f.notices.length,1);
});
test('Weekly repetition respects its final date', () => {
  const f=fixture({data:{events:[event('weekly',local(10,0,6),{repeat:'weekly',repeatUntil:'2026-11-06'})],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,0);
});
test('Monthly end-of-month recurrence produces a valid reminder', () => {
  const f=fixture({clock:local(10,0,28,1),data:{events:[event('monthly',local(10,0,31,0),{repeat:'monthly'})],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,1); assert.equal(f.notices[0].notice.start.getDate(),28);
});
test('All-day reminders use the local calendar date and no network', () => {
  const f=fixture({clock:local(0),data:{events:[event('all-day',local(0),{allDay:true,start:'2026-11-13',end:'2026-11-13'})],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,1); assert.match(f.notices[0].notice.body,/2026.11.13 종일 일정/);
});
test('Clock moving backwards cannot repeat an already shown trigger', () => {
  const f=fixture(); f.scheduler.tick(); f.setTime(local(9,59)); assert.equal(f.scheduler.tick().clockMovedBackwards,true);
  f.setTime(local()); f.scheduler.tick(); assert.equal(f.notices.length,1);
});
test('Malformed records do not block a valid event', () => {
  const f=fixture({data:{events:[null,event('bad',local(),{reminder:Infinity}),event('unknown',local(),{repeat:'unknown'}),event('date',local(),{start:'bad'}),event('good')],settings:{}}});
  f.scheduler.tick(); assert.equal(f.notices.length,1); assert.equal(f.notices[0].notice.eventId,'good');
});
test('Unreadable or invalid dedupe metadata does not stop reminders', () => {
  const f=fixture({overrides:{readState:()=>{throw Error('synthetic corrupt metadata')}}}); f.scheduler.tick();
  assert.equal(f.notices.length,1); assert.equal(f.errors[0].phase,'read-state');
  const g=fixture({saved:{value:{version:1,shown:[null,{key:1,shownAt:2},{key:'bad',shownAt:'wrong'}]}}}); g.scheduler.tick(); assert.equal(g.notices.length,1);
});
test('Dedupe write failure retains in-process protection and does not alter planner data', () => {
  const f=fixture({overrides:{writeState:()=>{throw Error('synthetic read-only metadata')}}});
  const original=JSON.stringify(f.data); f.scheduler.tick(); f.scheduler.tick();
  assert.equal(f.notices.length,1); assert.equal(JSON.stringify(f.data),original); assert.equal(f.errors[0].phase,'write-state');
});
test('Persistent sidecar survives a scheduler restart and leaves the main JSON untouched', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'planner-reminder-test-'));
  try {
    const main=path.join(dir,'planner-data.json'), stateFile=path.join(dir,'planner-reminder-state.json');
    fs.writeFileSync(main,'synthetic planner JSON sentinel');
    const f=fixture({overrides:{stateFile,readState:undefined,writeState:undefined}}); f.scheduler.tick();
    assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).shown.length,1);
    const g=fixture({overrides:{stateFile,readState:undefined,writeState:undefined}}); g.scheduler.tick(); assert.equal(g.notices.length,0);
    assert.equal(fs.readFileSync(main,'utf8'),'synthetic planner JSON sentinel'); assert(!fs.existsSync(stateFile+'.tmp'));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('Expired remembered keys are pruned and disposal cancels outstanding OS handles', () => {
  const f=fixture({autoShow:false,saved:{value:{version:1,shown:[{key:'ancient',shownAt:local()-40*24*60*minute}]}}});
  f.scheduler.tick(); assert(!f.saved.value.shown.some(row=>row.key==='ancient'));
  f.scheduler.dispose(); assert.equal(f.notices[0].closed,1); assert.equal(f.scheduler.tick().disposed,true);
});
test('Invalid scheduler limits are rejected explicitly', () => {
  assert.throws(()=>createReminderScheduler({getData:()=>({}),notify:()=>{},maxPerTick:0}),/Invalid/);
  assert.throws(()=>createReminderScheduler({getData:()=>({}),notify:()=>{},catchUpMs:Infinity}),/Invalid/);
});
console.log(`${passed} offline reminder checks passed`);
