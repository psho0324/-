// Inspect the actual ASAR produced by electron-builder, not a proposed file list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.resolve(process.env.PLANNER_ASAR_PATH || process.argv[2] || path.join(root, 'dist/win-unpacked/resources/app.asar'));
assert(fs.existsSync(archive), 'Missing built archive: ' + archive);
const entries = asar.listPackage(archive).map(p => p.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
const files = entries.filter(p => !asar.statFile(archive, p).files);
const required = ['main.js', 'preload.js', 'store.js', 'renderer/index.html', 'renderer/app.js', 'renderer/styles.css', 'renderer/storage.js', 'renderer/recurrence.js', 'renderer/holidays.js', 'renderer/quickadd.js', 'assets/icon.png', 'assets/icon.ico', 'package.json'];
for (const file of required) assert(files.includes(file), 'Required runtime file missing: ' + file);
for (const file of files) {
  assert(/^(?:main\.js|preload\.js|store\.js|package\.json|renderer\/.+|assets\/.+)$/.test(file), 'Unexpected packaged file: ' + file);
  assert(!/(?:^|\/)(?:test|tests|tools|node_modules|backups|\.git)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|planner-(?:data|config)\.json|\.log$|preview-seed|README/i.test(file), 'Development or private data in package: ' + file);
  if (file !== 'package.json') assert.deepEqual(asar.extractFile(archive, file), fs.readFileSync(path.join(root, file)), 'Packaged source differs: ' + file);
}
const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(pkg.name, 'my-planner');
assert.equal(pkg.main, 'main.js');
console.log('PASS: actual packaged ASAR contains all runtime code and icons; no tests, tools, preview seeds, dependencies, or personal data files.');
