// Inspect the actual packaged application and the NSIS update metadata.
// Keep CI failures readable from the public job annotations even without log access.
process.on('uncaughtException', error => {
  const message = String(error.stack || error.message || error).slice(0, 12000);
  console.error('::error title=Packaged application validation::' + message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  process.exit(1);
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const archive = path.resolve(process.env.PLANNER_ASAR_PATH || process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(root, 'dist/win-unpacked/resources/app.asar'));
assert(fs.existsSync(archive), 'Missing built archive: ' + archive);
const entries = asar.listPackage(archive).map(p => p.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
// ASAR's lookup API splits on the host separator; keep POSIX only for policy checks.
const files = entries.filter(p => !asar.statFile(archive, path.normalize(p)).files);
const required = ['main.js', 'preload.js', 'store.js', 'updater.js', 'renderer/index.html', 'renderer/app.js', 'renderer/styles.css', 'renderer/storage.js', 'renderer/recurrence.js', 'renderer/holidays.js', 'renderer/quickadd.js', 'assets/icon.png', 'assets/icon.ico', 'package.json'];
for (const file of required) assert(files.includes(file), 'Required runtime file missing: ' + file);
// Compare runtime dependency names AND versions with npm's installed production tree.
const production = new Set();
function collect(tree) {
  for (const [name, dependency] of Object.entries(tree.dependencies || {})) {
    production.add(name + '@' + dependency.version);
    collect(dependency);
  }
}
collect(JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: root, encoding: 'utf8' })));
const checkedPackages = new Set();
for (const file of files) {
  assert(!/(?:^|\/)(?:backups|\.git|\.cache)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)planner-(?:data|config)\.json$|\.log$/.test(file), 'Private/cache file in package: ' + file);
  if (file.startsWith('node_modules/')) {
    for (const match of file.matchAll(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/g)) {
      const folder = file.slice(0, match.index + match[0].length);
      if (checkedPackages.has(folder)) continue;
      const dependency = JSON.parse(asar.extractFile(archive, path.normalize(folder + '/package.json')));
      assert.equal(dependency.name, match[1]);
      assert(production.has(dependency.name + '@' + dependency.version), 'Non-production dependency in package: ' + folder);
      checkedPackages.add(folder);
    }
  } else {
    assert(/^(?:main\.js|preload\.js|store\.js|updater\.js|package\.json|renderer\/.+|assets\/.+)$/.test(file), 'Unexpected app file: ' + file);
    assert(!/preview-seed|README/i.test(file), 'Development data in package: ' + file);
    if (file !== 'package.json') assert.deepEqual(asar.extractFile(archive, path.normalize(file)), fs.readFileSync(path.join(root, file)), 'Packaged source differs: ' + file);
  }
}
const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'my-planner');
assert.equal(pkg.main, 'main.js');
assert.equal(pkg.version, sourcePackage.version);
assert.equal(pkg.dependencies['electron-updater'], sourcePackage.dependencies['electron-updater']);
assert(checkedPackages.has('node_modules/electron-updater'), 'Updater runtime missing');
const config = yaml.load(fs.readFileSync(path.join(path.dirname(archive), 'app-update.yml'), 'utf8'));
assert.equal(config.provider, 'github'); assert.equal(config.owner, 'psho0324'); assert.equal(config.repo, '-');
if (process.argv.includes('--archive-only')) {
  console.log('PASS: actual ASAR runtime/dependencies/update feed; NSIS output metadata NOT checked (--archive-only).');
} else {
const dist = path.join(root, 'dist');
const metadata = yaml.load(fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'));
assert.equal(metadata.version, sourcePackage.version);
const installer = metadata.files.find(f => f.url === 'MyPlanner-Setup.exe');
assert(installer, 'Stable installer file missing from update metadata');
const bytes = fs.readFileSync(path.join(dist, 'MyPlanner-Setup.exe'));
const digest = crypto.createHash('sha512').update(bytes).digest('base64');
assert.equal(installer.sha512, digest, 'Update metadata hash does not match installer');
if (metadata.sha512) assert.equal(metadata.sha512, digest);
assert.equal(installer.size, bytes.length);
console.log('PASS: ASAR runtime and production dependencies only; private data excluded; generated updater feed/version/SHA512 match NSIS installer.');
}
