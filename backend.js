/* Supabase REST client. Authorization is enforced by database row-level policies. */
(() => {
  const config = window.WORKSPACE_CONFIG || {};
  const base = (config.supabaseUrl || '').replace(/\/$/, '');
  const key = config.publishableKey || '';
  const configured = Boolean(base && key);
  let configurationError = '';
  if (configured) {
    try {
      const parsed = new URL(base);
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error();
      if (key.startsWith('sb_secret_')) throw Error();
      if (key.startsWith('eyJ')) {
        const claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.role !== 'anon') throw Error();
      } else if (!key.startsWith('sb_publishable_')) throw Error();
    } catch { configurationError = '연결 설정을 확인해 주세요. HTTPS Project URL과 공개용 publishable key가 필요합니다.'; }
  }
  const storageKey = 'wanderer-admin-session-v1';
  let current = null;
  try { current = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Storage may be unavailable. */ }
  function setSession(value) {
    current = value;
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* Keep session in memory. */ }
  }
  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    if (!configured || configurationError) throw new Error(configurationError || '저장 서비스를 먼저 연결해 주세요.');
    const response = await fetch(base + path, {
      method,
      headers: { apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      try { data = JSON.parse(text); } catch { /* Use a safe status message for non-JSON responses. */ }
    }
    if (!response.ok) {
      const authMessage = data?.error_code === 'invalid_credentials' ? '이메일 또는 비밀번호가 올바르지 않습니다.' : data?.error_code === 'email_not_confirmed' ? '이메일 확인이 필요합니다. Supabase에서 관리자 계정의 이메일 확인 상태를 확인해 주세요.' : '';
      const error = new Error(authMessage || (response.status === 401 ? '로그인이 만료되었거나 이메일·비밀번호가 올바르지 않습니다.' : response.status === 403 ? '관리 권한이 없습니다. 계정 권한을 확인해 주세요.' : response.status === 409 ? '연결된 제작 기록이 있거나 같은 ID가 이미 있습니다. 항목을 확인해 주세요.' : '요청을 처리하지 못했습니다. 연결 설정과 입력 내용을 확인하고 다시 시도해 주세요.'));
      error.status = response.status;
      error.code = data?.code;
      throw error;
    }
    return data;
  }
  let refreshing;
  async function session() {
    if (!current) return null;
    if (current.expires_at * 1000 > Date.now() + 60000) return current;
    if (!refreshing) refreshing = request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: current.refresh_token } })
      .then(data => { setSession({ ...data, expires_at: data.expires_at || Math.floor(Date.now() / 1000) + data.expires_in }); return current; })
      .catch(error => { setSession(null); throw error; }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function authorized(path, options = {}) {
    const auth = await session();
    if (!auth) throw new Error('먼저 로그인해 주세요.');
    try { return await request(path, { ...options, token: auth.access_token }); }
    catch (error) { if (error.status === 401) setSession(null); throw error; }
  }
  function projectFromRow(row) {
    return { id: row.id, name: row.name, category: row.category, description: row.description, status: row.status, tags: row.tags, note: row.note, url: row.url, imageUrl: row.image_url, showInProjects: row.show_in_projects, isPublished: row.is_published, sortOrder: row.sort_order };
  }
  function entryFromRow(row) { return { id: row.id, projectId: row.project_id, date: row.date, title: row.title, summary: row.summary, body: row.body, isPublished: row.is_published }; }
  async function load(admin = false) {
    const get = admin ? authorized : request;
    const [projects, entries] = await Promise.all([
      get('/rest/v1/projects?select=*&order=sort_order.asc,id.asc' + (admin ? '' : '&is_published=eq.true')),
      get('/rest/v1/journal_entries?select=*&order=date.desc,id.desc' + (admin ? '' : '&is_published=eq.true'))
    ]);
    return { projects: projects.map(projectFromRow), entries: entries.map(entryFromRow) };
  }
  window.WorkspaceBackend = {
    configured, configurationError, load,
    async login(email, password) {
      const data = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      setSession({ ...data, expires_at: data.expires_at || Math.floor(Date.now() / 1000) + data.expires_in });
    },
    async logout() {
      try { if (current) await authorized('/auth/v1/logout', { method: 'POST' }); }
      finally { setSession(null); }
    },
    async verifyAdmin() {
      if (!await session()) return null;
      const user = await authorized('/auth/v1/user');
      const rows = await authorized('/rest/v1/site_admins?select=user_id&user_id=eq.' + encodeURIComponent(user.id));
      if (!rows.length) { setSession(null); throw new Error('이 계정에는 관리 권한이 없습니다. Supabase에서 관리자 계정을 등록해 주세요.'); }
      return user;
    },
    async saveProject(project, creating) {
      const row = { name: project.name, category: project.category, description: project.description, status: project.status, tags: project.tags, note: project.note, url: project.url, image_url: project.imageUrl, show_in_projects: project.showInProjects, is_published: project.isPublished, sort_order: project.sortOrder };
      if (creating) row.id = project.id;
      const rows = await authorized('/rest/v1/projects' + (creating ? '' : '?id=eq.' + encodeURIComponent(project.id)), { method: creating ? 'POST' : 'PATCH', body: row, headers: { Prefer: 'return=representation' } });
      if (rows?.length !== 1) throw new Error('저장 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
      return projectFromRow(rows[0]);
    },
    async saveEntry(entry, creating) {
      const row = { project_id: entry.projectId, date: entry.date, title: entry.title, summary: entry.summary, body: entry.body, is_published: entry.isPublished };
      const rows = await authorized('/rest/v1/journal_entries' + (creating ? '' : '?id=eq.' + encodeURIComponent(entry.id)), { method: creating ? 'POST' : 'PATCH', body: row, headers: { Prefer: 'return=representation' } });
      if (rows?.length !== 1) throw new Error('저장 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
      return entryFromRow(rows[0]);
    },
    async remove(type, id) {
      if (!['projects', 'journal_entries'].includes(type)) throw new Error('삭제 대상이 올바르지 않습니다.');
      const rows = await authorized('/rest/v1/' + type + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (rows?.length !== 1) throw new Error('삭제 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
    }
  };
})();
