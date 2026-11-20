// Static NSIS integration contract and read-only verifier rejection cases.
// Actual hook execution is checked on Windows immediately after installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const { APP_RETURN_SCHEME } = require('../app-return');
const { inspectRegistration } = require('../tools/check-installed-protocol.cjs');

assert.equal(pkg.build.nsis.include, 'installer/protocol.nsh', 'NSIS needs an actual installer include, rather than generic protocol metadata');
const include = fs.readFileSync(path.join(__dirname, '..', pkg.build.nsis.include), 'utf8');
assert(include.includes('Software\\Classes\\' + APP_RETURN_SCHEME), 'Installer and app must use the same scheme');
const install = /!macro customInstall\s+([\s\S]*?)!macroend/.exec(include)?.[1];
const uninstall = /!macro customUnInstall\s+([\s\S]*?)!macroend/.exec(include)?.[1];
assert(install && uninstall, 'Both NSIS template hooks are required');
assert.match(install, /WriteRegStr SHCTX[^\r\n]+"URL Protocol" ""/);
assert.match(install, /WriteRegStr SHCTX[^\r\n]+\\DefaultIcon/);
assert.match(install, /WriteRegStr SHCTX[^\r\n]+\\shell\\open\\command/);
assert(include.includes('$INSTDIR\\${APP_EXECUTABLE_FILENAME}'), 'Use the installed executable in installer and uninstaller passes');
assert(include.includes('-- $\\"%1$\\"'), 'Terminate switch parsing before the external URL argument');
assert(!include.includes('$appExe') && !include.includes('$EXEDIR'), 'The uninstaller has no appExe variable and can run from a temporary copy');
assert(!/\bSetRegView\b|\bSetShellVarContext\b/.test(include), 'The template owns installation scope and registry view');
assert.match(uninstall, /Push \$0[\s\S]*Push \$1[\s\S]*ReadRegStr \$0 SHCTX/);
assert.match(uninstall, /\$\{If\} \$0 == \$1\s+DeleteRegKey SHCTX[^\r\n]+[\s\S]*?\$\{EndIf\}[\s\S]*Pop \$1\s+Pop \$0/);
for (const body of [install, uninstall]) assert.match(body, /SHChangeNotify\(i 0x08000000, i 0x1000, p 0, p 0\) v/);
assert(!pkg.build.files.some(file => file === '**/*' || file.startsWith('installer/')), 'Installer hook must stay outside packaged runtime files');

const executable = 'C:\\Program Files\\MyPlanner\\MyPlanner.exe';
const own = { exists: true, markerExists: true, marker: '', command: `"${executable}" -- "%1"`, icon: `"${executable}",0`, notRunning: true };
assert(Object.values(inspectRegistration(own, executable)).every(Boolean));
assert(Object.values(inspectRegistration({ ...own, command: own.command.toUpperCase(), icon: own.icon.toUpperCase() }, executable)).every(Boolean));
for (const changed of [
  { exists: false }, { markerExists: false }, { marker: null }, { marker: 0 },
  { command: `"C:\\Other\\MyPlanner.exe" "%1"` },
  { command: `"${executable}" "%1"` },
  { command: `"${executable}" "%1" --` },
  { command: `"${executable}" -- -- "%1"` },
  { command: `"${executable}" --hidden "%1"` },
  { command: `${executable} "%1"` },
  { command: ['unexpected'] }, { icon: 'other' }, { notRunning: false },
]) assert(!Object.values(inspectRegistration({ ...own, ...changed }, executable)).every(Boolean), 'Missing, foreign, extra-argument or already-launched registrations must not pass');
assert(!Object.values(inspectRegistration(null, executable)).every(Boolean));
assert(!JSON.stringify(inspectRegistration(own, executable)).includes(executable), 'Verifier result must not expose registry command paths');
console.log('PASS NSIS protocol integration contract and read-only registry verifier rejection cases (static/synthetic; Windows install executes separately)');
