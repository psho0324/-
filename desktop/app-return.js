// This link only opens the app. Credentials and OAuth responses stay on the
// validated loopback callback; they must never be passed through this protocol.
const APP_RETURN_SCHEME = 'tteodori-planner';
const APP_RETURN_URL = `${APP_RETURN_SCHEME}://open`;

function isAppReturnUrl(value) {
  return value === APP_RETURN_URL || value === APP_RETURN_URL + '/';
}

function classifyAppLaunch(argv) {
  if (!Array.isArray(argv)) return 'ignore';
  const links = argv.filter(value => typeof value === 'string'
    && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value));
  if (links.length === 0) return 'ordinary';
  return links.length === 1 && isAppReturnUrl(links[0]) ? 'return' : 'ignore';
}

module.exports = { APP_RETURN_SCHEME, APP_RETURN_URL, isAppReturnUrl, classifyAppLaunch };
