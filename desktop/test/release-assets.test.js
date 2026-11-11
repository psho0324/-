const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyReleaseAssets } = require('../tools/verify-release-assets.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-release-assets-'));
const names = ['MyPlanner-Setup.exe', 'latest.yml', 'SHA256SUMS.txt', 'installed.json', 'update-e2e.json'];
const fixture = values => ({ assets: values.map(name => ({ name })) });
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS', name); }
try {
  test('Release with every mandatory asset is accepted without optional blockmap', () => {
    assert.equal(verifyReleaseAssets(fixture(names), dir).length, 5);
  });
  for (const missing of names) test('Missing published asset stops release validation: ' + missing, () => {
    assert.throws(() => verifyReleaseAssets(fixture(names.filter(name => name !== missing)), dir), error => error.message.includes(missing));
  });
  test('A generated blockmap must also be published', () => {
    fs.writeFileSync(path.join(dir, 'MyPlanner-Setup.exe.blockmap'), 'synthetic test fixture');
    assert.throws(() => verifyReleaseAssets(fixture(names), dir), /blockmap/);
    assert.equal(verifyReleaseAssets(fixture([...names, 'MyPlanner-Setup.exe.blockmap']), dir).length, 6);
  });
  test('Malformed gh metadata cannot silently pass validation', () => {
    assert.throws(() => verifyReleaseAssets({}, dir));
    assert.throws(() => verifyReleaseAssets({ assets: [null] }, dir));
  });
  test('The CLI exits nonzero and annotates missing assets', () => {
    const file = path.join(dir, 'release.json'); fs.writeFileSync(file, JSON.stringify(fixture([])));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/verify-release-assets.cjs'), file, dir], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /::error title=Release assets verification::/); assert.match(result.stderr, /MyPlanner-Setup\.exe/);
  });
  console.log(passed + ' release asset checks passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
