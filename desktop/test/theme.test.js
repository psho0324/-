// Theme startup and OS-change behavior without Electron or a persistent user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/theme.js'), 'utf8');
let checks = 0;

function environment({ dark = false, cached, storageFails = false, mediaFails = false, legacy = false } = {}) {
  const attributes = {};
  const values = new Map(cached === undefined ? [] : [['planner-theme', cached]]);
  let listener;
  const media = { matches: dark };
  media[legacy ? 'addListener' : 'addEventListener'] = legacy
    ? callback => { listener = callback; }
    : (name, callback) => { assert.equal(name, 'change'); listener = callback; };
  const window = {
    document: { documentElement: { setAttribute(name, value) { attributes[name] = value; } } },
    localStorage: {
      getItem(key) { if (storageFails) throw Error('blocked'); return values.get(key) ?? null; },
      setItem(key, value) { if (storageFails) throw Error('quota'); values.set(key, value); }
    },
    matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); if (mediaFails) throw Error('unavailable'); return media; }
  };
  vm.runInNewContext(source, { window });
  return {
    theme: window.PlannerTheme, attributes, values,
    change(dark) { media.matches = dark; if (listener) listener({ matches: dark }); }
  };
}

function check(name, run) {
  run(); checks++;
  console.log('PASS', name);
}

check('First launch follows the OS before app data loads', () => {
  const env = environment({ dark: true });
  assert.equal(env.theme.getMode(), 'system');
  assert.equal(env.theme.getResolved(), 'dark');
  assert.equal(env.attributes['data-theme'], 'system');
  assert.equal(env.attributes['data-resolved-theme'], 'dark');
});
check('System mode follows OS changes in both directions', () => {
  const env = environment();
  env.change(true); assert.equal(env.theme.getResolved(), 'dark');
  env.change(false); assert.equal(env.theme.getResolved(), 'light');
});
check('Explicit light stays light while the OS is dark or changes', () => {
  const env = environment({ dark: true });
  assert.equal(env.theme.apply('light'), 'light');
  env.change(false); env.change(true);
  assert.equal(env.theme.getResolved(), 'light');
  assert.equal(env.attributes['data-resolved-theme'], 'light');
});
check('Explicit dark stays dark while the OS is light or changes', () => {
  const env = environment();
  env.theme.apply('dark');
  env.change(true); env.change(false);
  assert.equal(env.theme.getResolved(), 'dark');
});
check('Returning to system uses the current OS immediately', () => {
  const env = environment({ dark: true });
  env.theme.apply('light');
  env.theme.apply('system');
  assert.equal(env.theme.getResolved(), 'dark');
  env.change(false); assert.equal(env.theme.getResolved(), 'light');
});
check('The startup cache retains the choice across renderer restarts', () => {
  const first = environment(); first.theme.apply('dark');
  const second = environment({ cached: first.values.get('planner-theme') });
  assert.equal(second.theme.getMode(), 'dark');
  assert.equal(second.theme.getResolved(), 'dark');
});
check('Loaded file settings supersede the startup cache', () => {
  const env = environment({ cached: 'dark', dark: true });
  env.theme.apply('light');
  assert.equal(env.theme.getMode(), 'light');
  assert.equal(env.values.get('planner-theme'), 'light');
});
check('Malformed cached or loaded settings safely normalize to system', () => {
  const env = environment({ cached: '<script>', dark: true });
  assert.equal(env.theme.getMode(), 'system');
  for (const value of [undefined, null, '', 'DARK', false, {}, ['dark'], '<svg>']) {
    assert.equal(env.theme.apply(value), 'system');
    assert.equal(env.attributes['data-theme'], 'system');
    assert.equal(env.theme.getResolved(), 'dark');
  }
});
check('Blocked cache cannot prevent manual selection or OS-following', () => {
  const env = environment({ storageFails: true });
  env.theme.apply('dark'); assert.equal(env.theme.getResolved(), 'dark');
  env.theme.apply('system'); env.change(true);
  assert.equal(env.theme.getResolved(), 'dark');
});
check('Unavailable media query does not prevent manual dark selection', () => {
  const env = environment({ mediaFails: true });
  assert.equal(env.theme.getResolved(), 'light');
  env.theme.apply('dark'); assert.equal(env.theme.getResolved(), 'dark');
});
check('Older media-query listeners retain system support', () => {
  const env = environment({ legacy: true });
  env.change(true); assert.equal(env.theme.getResolved(), 'dark');
});
console.log(`Theme tests: ${checks} passed.`);
