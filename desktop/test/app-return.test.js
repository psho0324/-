const assert = require('node:assert/strict');
const { APP_RETURN_SCHEME, APP_RETURN_URL, isAppReturnUrl, classifyAppLaunch } = require('../app-return');
const pkg = require('../package.json');

for (const valid of [APP_RETURN_URL, APP_RETURN_URL + '/']) {
  assert.equal(isAppReturnUrl(valid), true);
  assert.equal(classifyAppLaunch(['C:\\Program Files\\MyPlanner.exe', valid]), 'return');
  assert.equal(classifyAppLaunch(['C:\\Program Files\\MyPlanner.exe', '--', valid]), 'return');
  assert.equal(classifyAppLaunch(['MyPlanner.exe', '--user-data-dir=C:\\CI Profile', '--', valid]), 'return');
}
const invalid = [
  null, undefined, {}, 1, '', ' ' + APP_RETURN_URL, APP_RETURN_URL + ' ',
  APP_RETURN_URL + '?code=SYNTHETIC', APP_RETURN_URL + '#access_token=SYNTHETIC',
  APP_RETURN_URL + '/other', APP_RETURN_URL + ':80',
  `${APP_RETURN_SCHEME}://user@open`, `${APP_RETURN_SCHEME}://open@other`,
  `${APP_RETURN_SCHEME}://%6fpen`, `${APP_RETURN_SCHEME}://open/%2e`,
  `${APP_RETURN_SCHEME}:open`, `${APP_RETURN_SCHEME}:/open`,
  `${APP_RETURN_SCHEME}://other`, 'https://example.invalid/', 'file:///example',
  APP_RETURN_URL + '\r\n',
];
for (const value of invalid) assert.equal(isAppReturnUrl(value), false, 'Only the static app-open URL is allowed');
for (const value of invalid.filter(value => typeof value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value))) {
  assert.equal(classifyAppLaunch(['MyPlanner.exe', value]), 'ignore');
  assert.equal(classifyAppLaunch(['MyPlanner.exe', '--', value]), 'ignore');
}
assert.equal(classifyAppLaunch(['MyPlanner.exe', APP_RETURN_URL, APP_RETURN_URL]), 'ignore');
assert.equal(classifyAppLaunch(['MyPlanner.exe', APP_RETURN_URL, 'https://example.invalid/']), 'ignore');
assert.equal(classifyAppLaunch(['C:\\Program Files\\MyPlanner.exe', '--hidden']), 'ordinary');
assert.equal(classifyAppLaunch(['/test/electron', '/test/desktop', '--user-data-dir=/test/profile']), 'ordinary');
assert.equal(classifyAppLaunch(null), 'ignore');
assert(pkg.build.files.includes('app-return.js'), 'The installed app needs its protocol validator');
console.log('PASS app-open protocol: fixed link, malformed/credential/foreign/duplicate rejection, ordinary launches and packaged validator');
