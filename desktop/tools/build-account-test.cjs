// Private directory build only. Never edits the original package or publishes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execSync } = require('node:child_process');
const { validateConfig } = require('../account-service.js');

const TEST_NAME = 'my-planner-account-test';
const TEST_APP_ID = 'com.myplanner.app.accounttest';
const TEST_EXE = 'MyPlannerAccountTest';
const TEST_TARGET = '0.1.3';
const ROOT_RUNTIME = Object.freeze([
  'main.js', 'preload.js', 'store.js', 'updater.js', 'account-service.js', 'app-return.js',
  'sync-service.js', 'reminders.js', 'account-config.json',
]);
const PACKAGE_FILES = Object.freeze([...ROOT_RUNTIME, 'renderer/**', 'assets/**', 'package.json']);
const MARKER = '.planner-account-test-output.json';
const PRIVATE_NAME = /^(?:\.git|\.cache|\.env(?:\..*)?|node_modules|backups|test-results|out|dist|preview|preview-seed\.js|planner-(?:data|config|sync-state|reminder-state)\.json(?:\..*)?|planner-sync-recovery-.*\.json(?:\..*)?|planner-account-session\.enc(?:\..*)?)$/i;
const WEB_ASSET = /\.(?:html|js|css|svg|png|ico|jpe?g|webp|woff2?|ttf|otf)$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Runtime input must be a regular file: ' + file);
}
function readJson(file) { regularFile(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function validateSourcePackage(pkg) {
  if (pkg?.name !== 'my-planner' || pkg.main !== 'main.js' || pkg.plannerAccountTest === true ||
      typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error('A production my-planner source package with its unchanged version is required');
  }
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || !pkg.dependencies['electron-updater'] ||
      typeof pkg.devDependencies?.electron !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.devDependencies.electron)) {
    throw new Error('Locked planner runtime and Electron dependencies are required');
  }
}
function validatePublicConfig(config) {
  if (!config || Object.keys(config).some(key => !['url', 'publishableKey'].includes(key)) || !validateConfig(config)) {
    throw new Error('A valid public Supabase URL/publishable key configuration is required; secrets are not allowed');
  }
}
function validateTestManifest(pkg, sourceVersion) {
  if (!sourceVersion || pkg?.version !== sourceVersion || pkg.plannerAccountTest !== true || pkg.plannerTestTarget !== TEST_TARGET ||
      pkg.name !== TEST_NAME || pkg.productName !== TEST_NAME || pkg.main !== 'main.js' ||
      pkg.build?.productName !== TEST_NAME || pkg.build?.appId !== TEST_APP_ID || pkg.build?.win?.executableName !== TEST_EXE ||
      pkg.build?.publish !== null || pkg.build?.asar !== true || pkg.build?.npmRebuild !== false ||
      pkg.build?.win?.signAndEditExecutable !== false || JSON.stringify(pkg.build?.files) !== JSON.stringify(PACKAGE_FILES)) {
    throw new Error('Private test manifest identity, publish policy, file list, or version is unsafe');
  }
  const forbidden = ['extends', 'extraFiles', 'extraResources', 'beforeBuild', 'beforePack', 'afterPack', 'afterSign', 'afterAllArtifactBuild'];
  if (forbidden.some(key => pkg.build[key] !== undefined) || pkg.scripts || pkg.devDependencies) throw new Error('Private test manifest may not inherit build hooks, package scripts or development dependencies');
  const targets = pkg.build.win.target;
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0].target !== 'dir' || JSON.stringify(targets[0].arch) !== '["x64"]') {
    throw new Error('Private test build must target only a Windows x64 directory');
  }
  return true;
}
function validateOutput(source, output, version) {
  if (inside(output, source)) throw new Error('Output may not be the source directory or an ancestor');
  for (const name of ['renderer', 'assets', 'node_modules', '.git', 'tools', 'test']) {
    if (inside(path.join(source, name), output)) throw new Error('Output may not be inside runtime, dependency, or source-tool folders');
  }
  let parent = output;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const canonical = path.join(fs.realpathSync(parent), path.relative(parent, output));
  if (canonical !== output) throw new Error('Output path may not traverse symbolic links');
  const markerFile = path.join(output, MARKER);
  if (fs.existsSync(markerFile)) {
    const marker = readJson(markerFile);
    if (marker.tool !== TEST_NAME || marker.appId !== TEST_APP_ID || marker.sourceVersion !== version) throw new Error('Output belongs to a different build');
  } else if (fs.existsSync(path.join(output, 'windows'))) {
    throw new Error('Refusing to overwrite an unrecognized Windows output directory');
  }
}
function copyRuntimeTree(source, destination, copied, prefix) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Runtime tree must be a real directory: ' + source);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || PRIVATE_NAME.test(entry.name)) continue;
    const input = path.join(source, entry.name), output = path.join(destination, entry.name), relative = prefix + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Runtime symbolic links are not allowed: ' + relative);
    if (entry.isDirectory()) copyRuntimeTree(input, output, copied, relative);
    else if (entry.isFile() && WEB_ASSET.test(entry.name)) { fs.copyFileSync(input, output); copied.push(relative); }
    else if (!entry.isFile()) throw new Error('Special runtime files are not allowed: ' + relative);
  }
}

function productionTree(sourceDir) {
  return JSON.parse(execSync('npm ls --omit=dev --all --long --json', {
    cwd: sourceDir, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  }));
}
function copyProductionPackage(input, output) {
  const stat = fs.lstatSync(input);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Production package must be a real directory: ' + input);
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
    // Compiled out/ and dist/ folders are essential runtime content. Only skip
    // private metadata and nested dependencies, which are copied from npm's tree.
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || /\.log$/i.test(entry.name)) continue;
    const from = path.join(input, entry.name), to = path.join(output, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Production package symbolic links are not allowed: ' + from);
    if (entry.isDirectory()) copyProductionPackage(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error('Special production files are not allowed: ' + from);
  }
}
function materializeProductionDependencies(sourceDir, projectDir, tree = productionTree(sourceDir)) {
  const modules = path.join(sourceDir, 'node_modules'), packages = new Map();
  function visit(parent) {
    for (const [name, dependency] of Object.entries(parent.dependencies || {})) {
      if (typeof dependency?.path !== 'string' || !path.isAbsolute(dependency.path) || !inside(modules, dependency.path) ||
          typeof dependency.version !== 'string' || dependency.missing || dependency.invalid || dependency.link) {
        throw new Error('A complete installed production dependency tree is required: ' + name);
      }
      // package-lock.json keys stay POSIX even when npm's physical paths use
      // Windows separators. The destination accepts these portable separators.
      const relative = path.relative(sourceDir, dependency.path).split(path.sep).join('/');
      if (!packages.has(relative)) {
        const pkg = readJson(path.join(dependency.path, 'package.json'));
        if (pkg.name !== name || pkg.version !== dependency.version) throw new Error('Installed production identity mismatch: ' + name);
        copyProductionPackage(dependency.path, path.join(projectDir, relative));
        packages.set(relative, { name, version: dependency.version, path: relative });
      }
      visit(dependency);
    }
  }
  visit(tree);
  return [...packages.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function prepareStage({ sourceDir = path.resolve(__dirname, '..'), outputDir = path.join(sourceDir, 'out', 'account-test'), includeDependencies = false, dependencyTree } = {}) {
  sourceDir = fs.realpathSync(sourceDir); outputDir = path.resolve(outputDir);
  const pkgFile = path.join(sourceDir, 'package.json'), lockFile = path.join(sourceDir, 'package-lock.json');
  const originalPackage = fs.readFileSync(pkgFile), originalLock = fs.readFileSync(lockFile);
  const source = readJson(pkgFile), lock = readJson(lockFile);
  validateSourcePackage(source);
  if (lock.version !== source.version || lock.packages?.['']?.version !== source.version || lock.name !== source.name) throw new Error('Source package and lock metadata must agree');
  validatePublicConfig(readJson(path.join(sourceDir, 'account-config.json')));
  validateOutput(sourceDir, outputDir, source.version);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-account-test-stage-'));
  const copied = [];
  try {
    for (const file of ROOT_RUNTIME) {
      regularFile(path.join(sourceDir, file));
      fs.copyFileSync(path.join(sourceDir, file), path.join(projectDir, file)); copied.push(file);
    }
    for (const tree of ['renderer', 'assets']) copyRuntimeTree(path.join(sourceDir, tree), path.join(projectDir, tree), copied, tree);
    for (const required of ['renderer/index.html', 'renderer/app.js', 'assets/icon.png', 'assets/icon.ico']) {
      if (!copied.includes(required)) throw new Error('Required runtime asset missing: ' + required);
    }
    const manifest = {
      name: TEST_NAME, productName: TEST_NAME, version: source.version, main: 'main.js',
      description: '내 플래너 계정 연결 전용 테스트', author: '떠돌이', license: source.license || 'UNLICENSED', private: true,
      plannerAccountTest: true, plannerTestTarget: TEST_TARGET,
      ...(source.engines ? { engines: clone(source.engines) } : {}),
      dependencies: clone(source.dependencies),
      build: {
        appId: TEST_APP_ID, productName: TEST_NAME, asar: true, npmRebuild: false,
        electronVersion: source.devDependencies.electron, artifactName: TEST_EXE + '.exe',
        directories: { output: path.join(outputDir, 'windows'), buildResources: 'assets' }, files: [...PACKAGE_FILES],
        win: { target: [{ target: 'dir', arch: ['x64'] }], icon: 'assets/icon.ico', executableName: TEST_EXE, signAndEditExecutable: false },
        publish: null,
      },
    };
    validateTestManifest(manifest, source.version);
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const productionPackages = includeDependencies ? materializeProductionDependencies(sourceDir, projectDir, dependencyTree) : [];
    lock.name = TEST_NAME; lock.packages[''].name = TEST_NAME;
    delete lock.packages[''].devDependencies;
    if (includeDependencies) {
      const filtered = { '': lock.packages[''] };
      for (const item of productionPackages) {
        const locked = lock.packages[item.path];
        if (!locked || locked.version !== item.version) throw new Error('Production lock identity mismatch: ' + item.name);
        filtered[item.path] = clone(locked); delete filtered[item.path].dev; delete filtered[item.path].devOptional;
      }
      lock.packages = filtered;
    }
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    fs.mkdirSync(outputDir, { recursive: true });
    const metadata = {
      tool: TEST_NAME, appId: TEST_APP_ID, sourceVersion: source.version, plannerTestTarget: TEST_TARGET,
      plannerAccountTest: true, windowsExecuted: false, published: false, autoUpdateAllowed: false, autoStartAllowed: false,
      dataDirectoryName: TEST_NAME, executable: TEST_EXE + '.exe', publicBackend: readJson(path.join(projectDir, 'account-config.json')).url,
      productionPackages,
      copiedFiles: copied.sort().map(file => ({ path: file, sha256: digest(fs.readFileSync(path.join(projectDir, file))) })),
    };
    fs.writeFileSync(path.join(outputDir, MARKER), JSON.stringify(metadata, null, 2) + '\n');
    if (!fs.existsSync(path.join(outputDir, 'ACCOUNT-TEST.txt'))) fs.writeFileSync(path.join(outputDir, 'ACCOUNT-TEST.txt'),
      'PRIVATE ACCOUNT TEST\nBase package version: ' + source.version + '\nPlanned target: ' + TEST_TARGET +
      '\nData directory: %APPDATA%\\' + TEST_NAME + '\nExecutable: ' + TEST_EXE +
      '.exe\nAutomatic updates and automatic startup must be disabled by the test-build runtime guard.\n' +
      'No installer or public release is produced. Actual Windows execution and live sign-in remain separate checks.\n');
    return { projectDir, outputDir, sourceDir, sourceVersion: source.version, manifest, metadata,
      sourceHashes: { package: digest(originalPackage), lock: digest(originalLock) } };
  } catch (error) {
    fs.rmSync(projectDir, { recursive: true, force: true });
    throw error;
  }
}

async function buildAccountTest(options = {}) {
  const stage = prepareStage({ ...options, includeDependencies: !options.stageOnly });
  if (options.stageOnly) return stage;
  const builderEntry = path.join(stage.sourceDir, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(builderEntry)) throw new Error('Source-installed electron-builder is required');
  const args = [builderEntry, '--projectDir', stage.projectDir, '--win', '--x64', '--dir', '--publish', 'never'];
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  const run = options.run || (command => spawnSync(process.execPath, command.args, { cwd: command.sourceDir, env: command.env, stdio: 'inherit' }));
  const result = await run({ ...stage, builderEntry, args, env });
  if ((typeof result === 'number' ? result : result?.status) !== 0) throw new Error('Private Windows directory build failed; no release was published');
  validateTestManifest(readJson(path.join(stage.projectDir, 'package.json')), stage.sourceVersion);
  if (digest(fs.readFileSync(path.join(stage.sourceDir, 'package.json'))) !== stage.sourceHashes.package ||
      digest(fs.readFileSync(path.join(stage.sourceDir, 'package-lock.json'))) !== stage.sourceHashes.lock) throw new Error('Original package metadata changed during private build');
  const appDir = path.join(stage.outputDir, 'windows', 'win-unpacked');
  for (const file of [TEST_EXE + '.exe', 'resources/app.asar']) regularFile(path.join(appDir, file));
  return { ...stage, appDir, executablePath: path.join(appDir, TEST_EXE + '.exe') };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--stage-only') options.stageOnly = true;
    else if (['--out', '--source'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('A path is required after ' + flag);
      options[flag === '--out' ? 'outputDir' : 'sourceDir'] = path.resolve(value);
    } else throw new Error('Unknown argument: ' + flag);
  }
  return options;
}
if (require.main === module) {
  Promise.resolve().then(() => buildAccountTest(parseArgs(process.argv.slice(2)))).then(stage => {
    console.log(JSON.stringify({ projectDir: stage.projectDir, outputDir: stage.outputDir, appDir: stage.appDir || null,
      executablePath: stage.executablePath || null, sourceVersion: stage.sourceVersion, plannerTestTarget: TEST_TARGET,
      plannerAccountTest: true, published: false, windowsExecuted: false }));
  }).catch(error => { console.error('Account test build: ' + error.message); process.exitCode = 1; });
}

module.exports = { prepareStage, buildAccountTest, validateTestManifest, parseArgs, materializeProductionDependencies, productionTree, TEST_NAME, TEST_APP_ID, TEST_EXE, ROOT_RUNTIME, PACKAGE_FILES };
