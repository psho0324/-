const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict'),
  { spawn } = require('node:child_process');
const root = path.join(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('workspace_public_list'))
      res.end(JSON.stringify({ total: 1, items: [{ id: 'safe-app', data: { name: 'Public' } }] }));
    else
      res.end(
        JSON.stringify({
          id: 'safe-app',
          data: {
            name: '<script>unsafe</script>',
            description: 'A "quoted" description',
            note: 'Public detail only',
            url: 'javascript:alert(1)'
          }
        })
      );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const child = spawn(process.execPath, ['scripts/build.cjs'], {
      cwd: root,
      env: {
        ...process.env,
        WORKSPACE_SNAPSHOT: '1',
        WORKSPACE_BUILD_API: 'http://127.0.0.1:' + server.address().port,
        WORKSPACE_BUILD_KEY: 'sb_publishable_test'
      },
      stdio: 'pipe'
    });
    let output = '';
    child.stderr.on('data', (b) => (output += b));
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0, output);
    const html = fs.readFileSync(path.join(root, 'dist/projects/safe-app/index.html'), 'utf8');
    assert(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
    assert(!html.includes('href="javascript:'));
    assert(html.includes('property="og:title"'));
    assert(html.includes('Public detail only'));
    assert(
      fs.readFileSync(path.join(root, 'dist/sitemap.xml'), 'utf8').includes('projects/safe-app/')
    );
    assert(!fs.existsSync(path.join(root, 'dist/tests')));
    assert(!fs.existsSync(path.join(root, 'dist/.git')));
    console.log(
      'PASS: published-only static detail build, escaped user content, safe links, metadata, sitemap, no test or Git files in deployment.'
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
