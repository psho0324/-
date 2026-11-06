// Build static project detail pages using published data only. No administrator token is used.
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const root = path.join(__dirname, '..'),
  dist = path.join(root, 'dist'),
  site = 'https://psho0324.github.io/-/';
const escape = (value) =>
  String(value || '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
(async () => {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const name of [
    'index.html',
    'admin.html',
    '404.html',
    'style.css',
    'admin.css',
    'app.js',
    'admin.js',
    'backend.js',
    'config.js',
    'categories.js',
    'projects.js',
    'journal.js',
    'SETUP.md'
  ])
    fs.copyFileSync(path.join(root, name), path.join(dist, name));
  fs.cpSync(path.join(root, 'supabase'), path.join(dist, 'supabase'), { recursive: true });
  const urls = [site];
  let total = 0;
  if (process.env.WORKSPACE_SNAPSHOT === '1') {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
    const config = context.window.WORKSPACE_CONFIG;
    if (process.env.WORKSPACE_BUILD_API) config.supabaseUrl = process.env.WORKSPACE_BUILD_API;
    if (process.env.WORKSPACE_BUILD_KEY) config.publishableKey = process.env.WORKSPACE_BUILD_KEY;
    async function rpc(name, body) {
      const res = await fetch(config.supabaseUrl + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw Error('Published snapshot request failed: ' + res.status);
      return res.json();
    }
    let offset = 0;
    do {
      const page = await rpc('workspace_public_list', {
        p_kind: 'project',
        p_offset: offset,
        p_limit: 50
      });
      total = page.total;
      for (const item of page.items) {
        if (!/^[a-z0-9-]+$/.test(item.id)) throw Error('Invalid public project id');
        const detail = await rpc('workspace_public_detail', { p_kind: 'project', p_id: item.id });
        if (!detail) continue;
        const p = detail.data,
          url = site + 'projects/' + item.id + '/',
          folder = path.join(dist, 'projects', item.id);
        fs.mkdirSync(folder, { recursive: true });
        const html =
          '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
          escape(p.name) +
          ' — 떠돌이의 작업실</title><meta name="description" content="' +
          escape(p.description) +
          '"><meta property="og:type" content="article"><meta property="og:title" content="' +
          escape(p.name) +
          '"><meta property="og:description" content="' +
          escape(p.description) +
          '"><meta property="og:url" content="' +
          url +
          '"><link rel="canonical" href="' +
          url +
          '"><link rel="stylesheet" href="../../style.css"></head><body><header class="nav wrap"><a class="brand" href="../../">↗ 떠돌이의 작업실</a></header><main class="wrap" style="padding-top:40px;padding-bottom:80px"><h1>' +
          escape(p.name) +
          '</h1><p class="description">' +
          escape(p.description) +
          '</p><p style="white-space:pre-wrap;line-height:1.9">' +
          escape(p.note) +
          '</p><div class="card-action">' +
          (/^https:\/\//.test(p.url || '')
            ? '<a class="primary" href="' +
              escape(p.url) +
              '" rel="noopener noreferrer" target="_blank">앱 열기 ↗</a>'
            : '') +
          '<a href="../../?project=' +
          encodeURIComponent(item.id) +
          '">최신 소개와 제작 기록 보기 ↗</a></div></main></body></html>';
        fs.writeFileSync(path.join(folder, 'index.html'), html);
        urls.push(url);
      }
      offset += page.items.length;
      if (!page.items.length) break;
    } while (offset < total);
  }
  fs.writeFileSync(
    path.join(dist, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      urls.map((url) => '<url><loc>' + escape(url) + '</loc></url>').join('') +
      '</urlset>'
  );
  fs.writeFileSync(
    path.join(dist, 'robots.txt'),
    'User-agent: *\nAllow: /\nDisallow: /-/admin.html\nSitemap: ' + site + 'sitemap.xml\n'
  );
  console.log('Built website and ' + (urls.length - 1) + ' published project detail pages.');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
