// Private build preparation only. Uses synthetic files and an injected builder.
// No network, Google login, actual installer, profile, or publication is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { prepareStage, buildAccountTest, validateTestManifest, parseArgs, productionTree, TEST_NAME, TEST_APP_ID, TEST_EXE, ROOT_RUNTIME, PACKAGE_FILES } = require('../tools/build-account-test.cjs');

const fixtures = [], stages = [];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const original = f => ({ package: fs.readFileSync(path.join(f.sourceDir, 'package.json')), lock: fs.readFileSync(path.join(f.sourceDir, 'package-lock.json')) });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-build-fixture-'));
  const sourceDir = path.join(dir, 'source'), outputDir = path.join(dir, 'private-output');
  fs.mkdirSync(sourceDir);
  for (const file of ROOT_RUNTIME) fs.writeFileSync(path.join(sourceDir, file), '// synthetic runtime ' + file + '\n');
  json(path.join(sourceDir, 'account-config.json'), { url: 'https://synthetic-planner.supabase.co', publishableKey: 'sb_publishable_SYNTHETIC_PUBLIC_KEY_0123456789' });
  for (const [file, content] of [['renderer/index.html', '<html>synthetic</html>'], ['renderer/app.js', '// synthetic app'], ['renderer/styles.css', 'body{}'], ['assets/icon.png', 'synthetic PNG'], ['assets/icon.ico', 'synthetic ICO']]) {
    const target = path.join(sourceDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  }
  const pkg = { name: 'my-planner', version: '0.1.2', main: 'main.js', author: 'SYNTHETIC_PRIVATE_AUTHOR_EMAIL', private: true,
    dependencies: { 'electron-updater': '6.8.11' }, devDependencies: { electron: '45.3.0', 'electron-builder': '26.18.0' },
    scripts: { postinstall: 'SYNTHETIC_SOURCE_BUILD_SECRET' },
    build: { appId: 'com.myplanner.app', productName: 'my-planner', publish: [{ provider: 'github' }],
      extraResources: ['planner-data.json'], beforePack: 'SYNTHETIC_SOURCE_BUILD_SECRET', extends: 'private-source-config.json' } };
  json(path.join(sourceDir, 'package.json'), pkg);
  json(path.join(sourceDir, 'package-lock.json'), { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } } });
  const f = { dir, sourceDir, outputDir }; fixtures.push(f); return f;
}
function prepare(f, options = {}) { const s = prepareStage({ ...f, ...options }); stages.push(s.projectDir); return s; }
function fakeDependencies(f) {
  const source = read(path.join(f.sourceDir, 'package.json')), lock = read(path.join(f.sourceDir, 'package-lock.json'));
  function add(relative, name, version, dependencies = {}, content = "module.exports = '" + version + "';") {
    const folder = path.join(f.sourceDir, relative); fs.mkdirSync(path.join(folder, 'out'), { recursive: true });
    json(path.join(folder, 'package.json'), { name, version, main: 'out/index.js', ...(Object.keys(dependencies).length ? { dependencies } : {}) });
    fs.writeFileSync(path.join(folder, 'out/index.js'), content);
    lock.packages[relative] = { version, ...(Object.keys(dependencies).length ? { dependencies } : {}) };
    return folder;
  }
  const builder = add('node_modules/electron-builder', 'electron-builder', '26.18.0'); fs.writeFileSync(path.join(builder, 'cli.js'), '// not executed\n');
  add('node_modules/electron', 'electron', '45.3.0');
  add('node_modules/electron-updater', 'electron-updater', '6.8.11', { 'builder-util-runtime': '9.7.0', 'js-yaml': '4.3.2', semver: '7.7.4' },
    "module.exports = {runtime:require('builder-util-runtime'),yaml:require('js-yaml'),semver:require('semver')};");
  add('node_modules/builder-util-runtime', 'builder-util-runtime', '9.7.0', { ms: '2.1.3' }, "module.exports = {version:'9.7.0',ms:require('ms')};");
  add('node_modules/ms', 'ms', '2.1.3'); add('node_modules/js-yaml', 'js-yaml', '4.3.2');
  add('node_modules/electron-updater/node_modules/semver', 'semver', '7.7.4');
  add('node_modules/semver', 'semver', '7.8.6');
  source.devDependencies.semver = '7.8.6'; source.devDependencies['js-yaml'] = '4.3.2';
  lock.packages[''].devDependencies = source.devDependencies;
  json(path.join(f.sourceDir, 'package.json'), source); json(path.join(f.sourceDir, 'package-lock.json'), lock);
}
function outputs(stage) {
  const folder = path.join(stage.outputDir, 'windows/win-unpacked/resources'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'app.asar'), 'synthetic archive'); fs.writeFileSync(path.join(folder, '..', TEST_EXE + '.exe'), 'synthetic exe');
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }

(async () => {
  await test('Staging has an explicit private identity and retains the source version', () => {
    const f = fixture(), before = original(f), s = prepare(f), p = read(path.join(s.projectDir, 'package.json'));
    assert.equal(validateTestManifest(p, '0.1.2'), true);
    assert.equal(p.plannerAccountTest, true); assert.equal(p.plannerTestTarget, '0.1.3');
    assert.equal(p.name, TEST_NAME); assert.equal(p.productName, TEST_NAME); assert.equal(p.build.appId, TEST_APP_ID); assert.equal(p.build.win.executableName, TEST_EXE);
    assert.deepEqual(original(f), before); assert.equal(read(path.join(s.projectDir, 'package-lock.json')).version, '0.1.2');
    assert.equal(read(path.join(s.projectDir, 'package-lock.json')).packages[''].name, TEST_NAME);
  });
  await test('Source lifecycle commands, hooks, publish settings and author details are not inherited', () => {
    const s = prepare(fixture()), text = fs.readFileSync(path.join(s.projectDir, 'package.json'), 'utf8'), p = JSON.parse(text);
    assert.equal(p.scripts, undefined); assert.equal(p.build.publish, null); assert.equal(p.build.npmRebuild, false);
    assert.equal(p.devDependencies, undefined);
    assert.equal(p.build.extraResources, undefined); assert.equal(p.build.beforePack, undefined); assert.equal(p.build.extends, undefined);
    assert.deepEqual(p.build.files, PACKAGE_FILES); assert(!text.includes('SYNTHETIC_SOURCE_BUILD_SECRET')); assert(!text.includes('SYNTHETIC_PRIVATE_AUTHOR_EMAIL'));
  });
  await test('Runtime copies exclude personal files, previews, hidden files and generated outputs', () => {
    const f = fixture();
    for (const file of ['planner-data.json', '.env', 'renderer/planner-data.json', 'renderer/planner-account-session.enc', 'renderer/preview-seed.js', 'renderer/debug.log', 'renderer/.hidden.js', 'renderer/backups/private.js', 'renderer/node_modules/private.js', 'assets/private.json']) {
      const target = path.join(f.sourceDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'SYNTHETIC_PRIVATE_DATA');
    }
    fs.mkdirSync(path.join(f.sourceDir, 'renderer/sub')); fs.writeFileSync(path.join(f.sourceDir, 'renderer/sub/public.svg'), '<svg/>');
    const s = prepare(f);
    for (const file of ['planner-data.json', '.env', 'renderer/planner-data.json', 'renderer/planner-account-session.enc', 'renderer/preview-seed.js', 'renderer/debug.log', 'renderer/.hidden.js', 'renderer/backups', 'renderer/node_modules', 'assets/private.json']) assert(!fs.existsSync(path.join(s.projectDir, file)), file);
    assert(fs.existsSync(path.join(s.projectDir, 'renderer/sub/public.svg')));
    assert(s.metadata.copiedFiles.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  });
  await test('Stage-only preparation never links or copies installed dependencies', () => {
    const f = fixture(); fakeDependencies(f); const s = prepare(f);
    assert(!fs.existsSync(path.join(s.projectDir, 'node_modules')));
    assert.equal(s.metadata.published, false); assert.equal(s.metadata.windowsExecuted, false);
    assert.equal(s.metadata.autoStartAllowed, false); assert.equal(s.metadata.autoUpdateAllowed, false);
    assert.equal(s.metadata.dataDirectoryName, TEST_NAME); assert.equal(s.metadata.publicBackend, 'https://synthetic-planner.supabase.co');
    assert(!JSON.stringify(s.metadata).includes('sb_publishable_'));
  });
  await test('A secret key is rejected before staging and never included in errors', () => {
    const f = fixture(), key = 'sb_secret_SYNTHETIC_NEVER_SHARE'; json(path.join(f.sourceDir, 'account-config.json'), { url: 'https://synthetic-planner.supabase.co', publishableKey: key });
    assert.throws(() => prepare(f), e => /secrets are not allowed/.test(e.message) && !e.message.includes(key));
    assert(!fs.existsSync(f.outputDir));
  });
  await test('Unknown credential fields and empty account configuration are rejected', () => {
    const f = fixture(), file = path.join(f.sourceDir, 'account-config.json');
    json(file, { ...read(file), clientSecret: 'SYNTHETIC_CLIENT_SECRET' }); assert.throws(() => prepare(f), /secrets are not allowed/);
    json(file, { url: '', publishableKey: '' }); assert.throws(() => prepare(f), /valid public Supabase/);
  });
  await test('Legacy anon keys are accepted while service-role JWTs are rejected', () => {
    const f = fixture(), file = path.join(f.sourceDir, 'account-config.json');
    const key = role => 'synthetic.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.synthetic';
    json(file, { url: 'https://synthetic-planner.supabase.co', publishableKey: key('anon') }); assert(prepare(f).projectDir);
    json(file, { url: 'https://synthetic-planner.supabase.co', publishableKey: key('service_role') }); assert.throws(() => prepare(f), /secrets are not allowed/);
  });
  await test('Runtime root symlinks cannot copy an external file', () => {
    const f = fixture(), outside = path.join(f.dir, 'outside-secret.js'); fs.writeFileSync(outside, 'SYNTHETIC_OUTSIDE');
    fs.unlinkSync(path.join(f.sourceDir, 'main.js')); fs.symlinkSync(outside, path.join(f.sourceDir, 'main.js'));
    assert.throws(() => prepare(f), /regular file/); assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_OUTSIDE');
  });
  await test('Runtime tree symlinks cannot escape the renderer directory', () => {
    const f = fixture(), outside = path.join(f.dir, 'external.js'); fs.writeFileSync(outside, 'synthetic');
    fs.symlinkSync(outside, path.join(f.sourceDir, 'renderer/linked.js')); assert.throws(() => prepare(f), /symbolic links/);
  });
  await test('Output cannot overwrite the source, its ancestors or runtime/tool directories', () => {
    const f = fixture(), before = original(f);
    for (const outputDir of [f.sourceDir, f.dir, path.join(f.sourceDir, 'renderer/build'), path.join(f.sourceDir, 'assets/build'), path.join(f.sourceDir, 'tools/build')]) assert.throws(() => prepare(f, { outputDir }), /Output may not/);
    assert.deepEqual(original(f), before);
  });
  await test('An unrecognized Windows output folder is never overwritten', () => {
    const f = fixture(), file = path.join(f.outputDir, 'windows/keep.txt'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'preserve');
    assert.throws(() => prepare(f), /unrecognized Windows output/); assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
  });
  await test('A recognized output can be reused only with matching identity and source version', () => {
    const f = fixture(), s = prepare(f), note = path.join(f.outputDir, 'ACCOUNT-TEST.txt'), evidence = path.join(f.outputDir, 'linux-check/report.json');
    fs.writeFileSync(note, 'Later owner guidance'); fs.mkdirSync(path.dirname(evidence)); fs.writeFileSync(evidence, 'owner evidence');
    assert(prepare(f).projectDir);
    assert.equal(fs.readFileSync(note, 'utf8'), 'Later owner guidance'); assert.equal(fs.readFileSync(evidence, 'utf8'), 'owner evidence');
    const marker = path.join(s.outputDir, '.planner-account-test-output.json'); const value = read(marker); value.sourceVersion = '0.1.3'; json(marker, value);
    assert.throws(() => prepare(f), /different build/);
  });
  await test('Changed source package/lock versions are rejected before copying', () => {
    const f = fixture(), file = path.join(f.sourceDir, 'package-lock.json'), lock = read(file); lock.version = '0.1.3'; json(file, lock);
    assert.throws(() => prepare(f), /package and lock metadata/);
  });
  await test('Manifest validation rejects test identity, hooks, release targets and version mutations', () => {
    const s = prepare(fixture());
    const changes = [p => { p.version = '0.1.3'; }, p => { p.plannerAccountTest = false; }, p => { p.name = 'my-planner'; }, p => { p.productName = 'my-planner'; }, p => { p.build.appId = 'com.myplanner.app'; }, p => { p.build.win.executableName = 'MyPlanner'; }, p => { p.build.publish = [{ provider: 'github' }]; }, p => { p.build.extraFiles = ['private.json']; }, p => { p.build.files.push('**/*'); }, p => { p.build.win.target[0].target = 'nsis'; }, p => { p.build.npmRebuild = true; }, p => { p.scripts = { postinstall: 'synthetic' }; }];
    for (const change of changes) { const p = structuredClone(s.manifest); change(p); assert.throws(() => validateTestManifest(p, '0.1.2')); }
  });
  await test('Hoisted and nested production dependencies are materialized without development packages or symlinks', () => {
    const f = fixture(); fakeDependencies(f); const before = original(f), s = prepare(f, { includeDependencies: true });
    assert(fs.lstatSync(path.join(s.projectDir, 'node_modules')).isDirectory());
    assert(!fs.lstatSync(path.join(s.projectDir, 'node_modules')).isSymbolicLink());
    assert(!fs.existsSync(path.join(s.projectDir, 'node_modules/electron-builder')));
    assert(!fs.existsSync(path.join(s.projectDir, 'node_modules/electron')));
    assert(!fs.existsSync(path.join(s.projectDir, 'node_modules/semver')));
    assert.deepEqual(require(path.join(s.projectDir, 'node_modules/electron-updater')), { runtime: { version: '9.7.0', ms: '2.1.3' }, yaml: '4.3.2', semver: '7.7.4' });
    assert.equal(s.metadata.productionPackages.length, 5);
    assert.equal(read(path.join(s.projectDir, 'package-lock.json')).packages[''].devDependencies, undefined);
    assert.deepEqual(original(f), before);
  });
  await test('Production dependency paths and versions must match the installed source tree', () => {
    const f = fixture(); fakeDependencies(f);
    const tree = productionTree(f.sourceDir); tree.dependencies['electron-updater'].path = f.dir;
    assert.throws(() => prepare(f, { includeDependencies: true, dependencyTree: tree }), /complete installed production dependency tree/);
    const different = productionTree(f.sourceDir); different.dependencies['electron-updater'].version = '0.0.0';
    assert.throws(() => prepare(f, { includeDependencies: true, dependencyTree: different }), /identity mismatch/);
  });
  await test('Production package file symlinks cannot smuggle outside content', () => {
    const f = fixture(); fakeDependencies(f); const outside = path.join(f.dir, 'outside.js'); fs.writeFileSync(outside, 'synthetic outside');
    fs.symlinkSync(outside, path.join(f.sourceDir, 'node_modules/electron-updater/out/linked.js'));
    assert.throws(() => prepare(f, { includeDependencies: true }), /Production package symbolic links/);
  });
  await test('Builder receives a private directory-only command and complete materialized dependencies', async () => {
    const f = fixture(); fakeDependencies(f); const before = original(f); let command;
    const s = await buildAccountTest({ ...f, run: async value => {
      command = value; stages.push(value.projectDir); assert(!fs.lstatSync(path.join(value.projectDir, 'node_modules')).isSymbolicLink());
      assert.notEqual(fs.realpathSync(path.join(value.projectDir, 'node_modules')), fs.realpathSync(path.join(f.sourceDir, 'node_modules')));
      assert.equal(value.metadata.productionPackages.length, 5);
      outputs(value); return { status: 0 };
    } });
    assert.equal(command.args.at(-2), '--publish'); assert.equal(command.args.at(-1), 'never'); assert(command.args.includes('--dir')); assert(!command.args.includes('nsis'));
    assert.equal(command.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false'); assert.equal(s.executablePath, path.join(s.appDir, TEST_EXE + '.exe'));
    assert.deepEqual(original(f), before);
  });
  await test('Builder failure never reports a published or successful package', async () => {
    const f = fixture(); fakeDependencies(f); const before = original(f);
    await assert.rejects(buildAccountTest({ ...f, run: value => { stages.push(value.projectDir); return { status: 9 }; } }), /failed; no release was published/);
    assert.deepEqual(original(f), before);
  });
  await test('A builder cannot silently change the staged version', async () => {
    const f = fixture(); fakeDependencies(f);
    await assert.rejects(buildAccountTest({ ...f, run: value => { stages.push(value.projectDir); outputs(value); const file = path.join(value.projectDir, 'package.json'), p = read(file); p.version = '0.1.3'; json(file, p); return 0; } }), /version is unsafe/);
  });
  await test('Original metadata changes during a build prevent a success result without overwriting them', async () => {
    const f = fixture(); fakeDependencies(f);
    await assert.rejects(buildAccountTest({ ...f, run: value => { stages.push(value.projectDir); outputs(value); const file = path.join(f.sourceDir, 'package.json'), p = read(file); p.description = 'later user edit'; json(file, p); return 0; } }), /Original package metadata changed/);
    assert.equal(read(path.join(f.sourceDir, 'package.json')).description, 'later user edit');
  });
  await test('A successful process must actually produce the expected executable and archive', async () => {
    const f = fixture(); fakeDependencies(f);
    await assert.rejects(buildAccountTest({ ...f, run: value => { stages.push(value.projectDir); return 0; } }), /ENOENT/);
  });
  await test('CLI stage-only uses argument arrays safely and reports no publication', () => {
    const f = fixture(), result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../tools/build-account-test.cjs'), '--stage-only', '--source', f.sourceDir, '--out', path.join(f.dir, 'output with spaces')], { encoding: 'utf8' }));
    stages.push(result.projectDir); assert.equal(result.published, false); assert.equal(result.windowsExecuted, false); assert.equal(result.sourceVersion, '0.1.2'); assert.equal(result.appDir, null);
    assert.equal(read(path.join(result.projectDir, 'package.json')).plannerAccountTest, true);
  });
  await test('CLI rejects unknown or incomplete flags instead of guessing an output', () => {
    assert.throws(() => parseArgs(['--publish']), /Unknown argument/); assert.throws(() => parseArgs(['--out']), /path is required/);
    assert.throws(() => parseArgs(['--source', '--out']), /path is required/);
    assert.deepEqual(parseArgs(['--stage-only']).stageOnly, true);
  });
  console.log(passed + ' private account-test build checks passed; fake builder only');
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
.finally(() => { for (const stage of stages) fs.rmSync(stage, { recursive: true, force: true }); for (const f of fixtures) fs.rmSync(f.dir, { recursive: true, force: true }); });
