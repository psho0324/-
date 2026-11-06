// Browser integration with a simulated Supabase API; real RLS is tested separately.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const seed = { window: {} }; vm.createContext(seed);
for (const file of ['projects.js', 'journal.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), seed);
const state = {
  projects: seed.window.projects.map(p => ({ id:p.id, name:p.name, category:p.category, description:p.description, status:p.status, tags:[...p.tags], note:p.note, url:p.url, image_url:'', show_in_projects:p.showInProjects !== false, is_published:true, sort_order:0 })),
  entries: seed.window.journalEntries.map(e => ({ id:e.id, project_id:e.projectId, date:e.date, title:e.title, summary:e.summary, body:e.body, is_published:true }))
};
let nextId = 4, failNextSave = false, refreshCount = 0;
const errors = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/plain');
  res.end(fs.readFileSync(file));
});
async function apiRoute(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method();
  const payload = req.postDataJSON();
  const token = req.headers().authorization;
  const admin = token === 'Bearer test-admin';
  const reply = (status, body) => route.fulfill({ status, contentType:'application/json', body:body === undefined ? '' : JSON.stringify(body) });
  if (url.pathname === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') === 'refresh_token') { refreshCount++; return reply(200, { access_token:'test-admin', refresh_token:'test-refresh', expires_in:3600, user:{id:'owner',email:'owner@example.test'} }); }
    if (payload.password !== 'test-password') return reply(400, {message:'invalid credentials'});
    return reply(200, {access_token:payload.email === 'owner@example.test' ? 'test-admin' : 'test-non-admin',refresh_token:'test-refresh',expires_in:3600,user:{id:payload.email === 'owner@example.test' ? 'owner' : 'other',email:payload.email}});
  }
  if (url.pathname === '/auth/v1/user') return reply(200,{id:admin ? 'owner':'other',email:admin ? 'owner@example.test':'other@example.test'});
  if (url.pathname === '/auth/v1/logout') return reply(204);
  if (url.pathname === '/rest/v1/site_admins') return reply(200, admin ? [{user_id:'owner'}] : []);
  const type = url.pathname === '/rest/v1/projects' ? 'projects' : 'entries';
  if (method === 'GET') {
    let list = state[type];
    if (!admin) list = list.filter(row => row.is_published && (type !== 'entries' || state.projects.some(p => p.id === row.project_id && p.is_published)));
    return reply(200,list);
  }
  if (!admin) return reply(403,{message:'not allowed'});
  if (failNextSave) { failNextSave = false; return reply(500,{message:'simulated failure'}); }
  if (method === 'POST') {
    const row = type === 'entries' ? {...payload,id:nextId++} : {...payload};
    state[type].push(row); return reply(201,[row]);
  }
  const id = url.searchParams.get('id')?.slice(3);
  const index = state[type].findIndex(row => String(row.id) === id);
  if (index < 0) return reply(200,[]);
  if (method === 'PATCH') { Object.assign(state[type][index],payload); return reply(200,[state[type][index]]); }
  if (method === 'DELETE') { const [deleted] = state[type].splice(index,1); return reply(200,[deleted]); }
  return reply(400,{});
}
async function makeContext(browser, base, configured) {
  const context = await browser.newContext();
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/config.js*', route => route.fulfill({contentType:'text/javascript',body:configured ? "window.WORKSPACE_CONFIG={supabaseUrl:'https://workspace-test.supabase.co',publishableKey:'sb_publishable_test',useDatabase:true}" : 'window.WORKSPACE_CONFIG={};'}));
  await context.route('https://workspace-test.supabase.co/**',apiRoute);
  return context;
}
async function login(page, base, email = 'owner@example.test') {
  await page.goto(base + '/admin.html');
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill('test-password');
  await page.getByRole('button',{name:'로그인',exact:true}).click();
}
(async()=>{
  await new Promise(resolve => server.listen(0,'0.0.0.0',resolve));
  const base = 'http://localhost:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    const offline = await makeContext(browser,base,false);
    const preview = await offline.newPage(); await preview.goto(base+'/admin.html');
    await preview.locator('#setup-panel').waitFor();
    assert(await preview.locator('#new-project').isDisabled()); assert(await preview.locator('#new-entry').isDisabled());
    assert(!await preview.locator('#login-panel').isVisible());
    await preview.goto(base+'/'); await preview.locator('.project-card').waitFor(); assert.equal(await preview.locator('.project-card').count(),1);
    await offline.close();
    const nonAdmin = await makeContext(browser,base,true); const forbidden = await nonAdmin.newPage();
    await login(forbidden,base,'other@example.test'); await forbidden.locator('#notice.error').waitFor();
    assert(!await forbidden.locator('#dashboard').isVisible()); assert(await forbidden.locator('#login-panel').isVisible()); await nonAdmin.close();
    const owner = await makeContext(browser,base,true); const page = await owner.newPage();
    await page.goto(base+'/admin.html'); await page.locator('#login-panel').waitFor();
    await login(page,base); await page.locator('#dashboard').waitFor(); assert.equal(await page.locator('#project-list .admin-item').count(),2);
    await page.locator('#new-project').click(); await page.locator('#project-name').fill('<script>unsafe</script>');
    await page.locator('#project-id').fill('new-app'); await page.locator('#project-description').fill('New application');
    await page.locator('#project-url').fill('http://example.test'); await page.locator('#save-item').click(); await page.locator('#editor-error').waitFor();
    assert(await page.locator('#editor').isVisible()); assert.equal(state.projects.length,2);
    await page.locator('#project-url').fill('https://example.test'); await page.locator('#project-tags').fill('도구, 실험');
    failNextSave = true; await page.locator('#save-item').click(); await page.locator('#editor-error').waitFor();
    assert(await page.locator('#editor').isVisible()); assert.equal(await page.locator('#project-name').inputValue(),'<script>unsafe</script>');
    await page.locator('#save-item').click(); await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(state.projects.length,3); assert.equal(state.projects.find(p=>p.id==='new-app').is_published,false);
    assert.equal(await page.locator('#stat-drafts').textContent(),'1');
    const visitor = await makeContext(browser,base,true); const publicPage = await visitor.newPage();
    await publicPage.goto(base+'/'); await publicPage.locator('.project-card').waitFor(); assert.equal(await publicPage.locator('.project-card').count(),1);
    const newCard = page.locator('.admin-item').filter({has:page.getByRole('heading',{name:'<script>unsafe</script>',exact:true})});
    await newCard.getByRole('button',{name:'수정',exact:true}).click(); assert(await page.locator('#project-id').isDisabled());
    await page.locator('#publish-state').selectOption('published'); await page.locator('#save-item').click(); await page.locator('#editor').waitFor({state:'hidden'});
    await publicPage.reload(); await publicPage.locator('.project-card').nth(1).waitFor(); assert.equal(await publicPage.locator('.project-card').count(),2);
    assert.equal(await publicPage.locator('.project-card script').count(),0);
    await page.getByRole('tab',{name:'제작 기록 관리'}).click(); await page.locator('#new-entry').click();
    await page.locator('#entry-project').selectOption('new-app'); await page.locator('#entry-title').fill('First update');
    await page.locator('#entry-summary').fill('A short summary'); await page.locator('#entry-body').fill('Line one\nLine two');
    await page.locator('#publish-state').selectOption('published'); await page.locator('#save-item').click(); await page.locator('#editor').waitFor({state:'hidden'});
    assert.equal(state.entries.length,4);
    await publicPage.reload(); await publicPage.getByRole('button',{name:'<script>unsafe</script> 제작 기록',exact:true}).click();
    assert.equal(await publicPage.locator('.journal-entry').count(),1); assert.equal(await publicPage.locator('.journal-entry h3').textContent(),'First update');
    await page.getByRole('tab',{name:'프로젝트 관리'}).click(); await newCard.getByRole('button',{name:'삭제',exact:true}).click();
    assert.match(await page.locator('#notice').textContent(),/연결되어/); assert(!await page.locator('#delete-dialog').isVisible());
    await newCard.getByRole('button',{name:'수정',exact:true}).click(); await page.locator('#publish-state').selectOption('draft');
    await page.locator('#save-item').click(); await page.locator('#editor').waitFor({state:'hidden'});
    await publicPage.reload(); await publicPage.getByRole('tab',{name:'제작 기록'}).click();
    assert.equal(await publicPage.locator('.journal-entry').count(),3);
    await page.getByRole('tab',{name:'제작 기록 관리'}).click(); await page.locator('#entry-project-filter').selectOption('new-app');
    await page.locator('#entry-list').getByRole('button',{name:'삭제',exact:true}).click(); await page.locator('#confirm-delete').click();
    await page.locator('#delete-dialog').waitFor({state:'hidden'}); assert.equal(state.entries.length,3);
    await page.getByRole('tab',{name:'프로젝트 관리'}).click(); await newCard.getByRole('button',{name:'삭제',exact:true}).click();
    await page.locator('#confirm-delete').click(); await page.locator('#delete-dialog').waitFor({state:'hidden'}); assert.equal(state.projects.length,2);
    // A copied expired session must be refreshed, not silently treated as authenticated.
    await page.evaluate(()=>{const s=JSON.parse(sessionStorage.getItem('wanderer-admin-session-v1'));s.expires_at=1;sessionStorage.setItem('wanderer-admin-session-v1',JSON.stringify(s));});
    await page.reload(); await page.locator('#dashboard').waitFor(); assert.equal(refreshCount,1);
    await page.screenshot({path:'/tmp/admin-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#new-project').click(); assert.equal(await page.locator('#editor').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    await page.locator('.close-editor[aria-label]').click(); await page.screenshot({path:'/tmp/admin-mobile.png',fullPage:true});
    await page.locator('#logout').click(); await page.locator('#login-panel').waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('wanderer-admin-session-v1')),null);
    await page.reload(); await page.locator('#login-panel').waitFor(); assert(!await page.locator('#dashboard').isVisible());
    assert.deepEqual(errors,[]);
    console.log('PASS: disconnected read-only preview; login and denied non-admin; project/record CRUD; failed-save input retention; HTTPS validation; draft publication; public refresh; parent-draft hiding; FK UI guard; safe text rendering; session refresh/logout; mobile layouts. Auth/API simulated; production Supabase not tested.');
    await owner.close(); await visitor.close();
  } finally { if(browser)await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
