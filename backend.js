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
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash)
        throw Error();
      if (key.startsWith('sb_secret_')) throw Error();
      if (key.startsWith('eyJ')) {
        const claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.role !== 'anon') throw Error();
      } else if (!key.startsWith('sb_publishable_')) throw Error();
    } catch {
      configurationError =
        '연결 설정을 확인해 주세요. HTTPS Project URL과 공개용 publishable key가 필요합니다.';
    }
  }
  const storageKey = 'wanderer-admin-session-v1';
  let current = null;
  try {
    current = JSON.parse(sessionStorage.getItem(storageKey));
  } catch {
    /* Storage may be unavailable. */
  }
  function setSession(value) {
    current = value;
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Keep session in memory. */
    }
  }
  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    if (!configured || configurationError)
      throw new Error(configurationError || '저장 서비스를 먼저 연결해 주세요.');
    const response = await fetch(base + path, {
      method,
      headers: {
        apikey: key,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        /* Use a safe status message for non-JSON responses. */
      }
    }
    if (!response.ok) {
      const authCode = data?.error_code || data?.code;
      const authMessages = {
        invalid_credentials:
          '이메일 또는 비밀번호가 올바르지 않습니다. 계정을 만들 때 정한 비밀번호를 사용하거나 아래에서 재설정해 주세요.',
        email_not_confirmed:
          '이메일 확인이 필요합니다. Supabase에서 관리자 계정의 이메일 확인 상태를 확인해 주세요.',
        over_email_send_rate_limit:
          '이메일 요청이 너무 잦습니다. 잠시 기다린 뒤 다시 시도해 주세요.',
        over_request_rate_limit: '로그인 요청이 너무 잦습니다. 잠시 기다린 뒤 다시 시도해 주세요.',
        weak_password:
          '더 강한 비밀번호를 입력해 주세요. Supabase의 비밀번호 규칙을 확인해 주세요.',
        same_password: '이전과 다른 새 비밀번호를 입력해 주세요.'
      };
      const transactionMessages = {
        workspace_conflict:
          '다른 탭에서 변경된 내용이 있습니다. 작성 내용은 유지했습니다. 최신 목록을 확인한 뒤 다시 수정해 주세요.',
        workspace_request_reused: '저장 요청 내용이 바뀌었습니다. 최신 항목을 확인해 주세요.',
        workspace_invalid_parent: '연결할 프로젝트가 휴지통에 있거나 존재하지 않습니다.'
      };
      const error = new Error(
        transactionMessages[data?.message] ||
          authMessages[authCode] ||
          (response.status === 401
            ? path.startsWith('/auth/v1/token?grant_type=password')
              ? '로그인 연결 정보를 확인하지 못했습니다. 사이트의 공개 API 키 설정을 확인해 주세요.'
              : '로그인이 만료되었습니다. 다시 로그인해 주세요.'
            : response.status === 403
              ? '관리 권한이 없거나 이메일 인증이 필요합니다. 계정 상태를 확인해 주세요.'
              : response.status === 409
                ? '연결된 제작 기록이 있거나 같은 ID가 이미 있습니다. 항목을 확인해 주세요.'
                : '요청을 처리하지 못했습니다. 연결 설정과 입력 내용을 확인하고 다시 시도해 주세요.')
      );
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
    if (!refreshing)
      refreshing = request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: current.refresh_token }
      })
        .then((data) => {
          setSession({
            ...data,
            recovery: Boolean(current?.recovery),
            expires_at: data.expires_at || Math.floor(Date.now() / 1000) + data.expires_in
          });
          return current;
        })
        .catch((error) => {
          setSession(null);
          throw error;
        })
        .finally(() => {
          refreshing = null;
        });
    return refreshing;
  }
  async function authorized(path, options = {}) {
    const auth = await session();
    if (!auth) throw new Error('먼저 로그인해 주세요.');
    try {
      return await request(path, { ...options, token: auth.access_token });
    } catch (error) {
      if (error.status === 401) setSession(null);
      throw error;
    }
  }
  function projectFromRow(row) {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      status: row.status,
      tags: row.tags,
      note: row.note,
      url: row.url,
      imageUrl: row.image_url,
      showInProjects: row.show_in_projects,
      isPublished: row.is_published,
      sortOrder: row.sort_order
    };
  }
  function entryFromRow(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      date: row.date,
      title: row.title,
      summary: row.summary,
      body: row.body,
      isPublished: row.is_published
    };
  }
  async function load(admin = false) {
    const get = admin ? authorized : request;
    const [projects, entries] = await Promise.all([
      get(
        '/rest/v1/projects?select=*&order=sort_order.asc,id.asc' +
          (admin ? '' : '&is_published=eq.true')
      ),
      get(
        '/rest/v1/journal_entries?select=*&order=date.desc,id.desc' +
          (admin ? '' : '&is_published=eq.true')
      )
    ]);
    return { projects: projects.map(projectFromRow), entries: entries.map(entryFromRow) };
  }
  window.WorkspaceBackend = {
    configured,
    configurationError,
    load,
    async login(email, password) {
      const data = await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password }
      });
      setSession({
        ...data,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + data.expires_in
      });
    },
    async sendPasswordReset(email) {
      const redirect = new URL('admin.html', window.location.href);
      await request('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirect.href), {
        method: 'POST',
        body: { email }
      });
    },
    consumeRecoveryLink() {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      if (hash.has('error') || hash.has('error_code')) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        setSession(null);
        throw new Error(
          '비밀번호 재설정 링크가 만료되었거나 유효하지 않습니다. 재설정 이메일을 다시 요청해 주세요.'
        );
      }
      if (hash.get('type') === 'recovery') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        if (!hash.get('access_token') || !hash.get('refresh_token')) {
          setSession(null);
          throw new Error('비밀번호 재설정 링크가 올바르지 않습니다. 이메일을 다시 요청해 주세요.');
        }
        setSession({
          access_token: hash.get('access_token'),
          refresh_token: hash.get('refresh_token'),
          expires_at:
            Math.floor(Date.now() / 1000) + Math.min(Number(hash.get('expires_in')) || 3600, 86400),
          recovery: true
        });
      }
      return Boolean(current?.recovery);
    },
    async verifyRecovery() {
      await authorized('/auth/v1/user');
    },
    async updatePassword(password) {
      if (!current?.recovery)
        throw new Error('이메일의 비밀번호 재설정 링크로 다시 접속해 주세요.');
      await authorized('/auth/v1/user', { method: 'PUT', body: { password } });
      try {
        await authorized('/auth/v1/logout', { method: 'POST' });
      } catch {
        /* The password was updated; always discard the local recovery session. */
      } finally {
        setSession(null);
      }
    },
    async logout() {
      try {
        if (current) await authorized('/auth/v1/logout', { method: 'POST' });
      } finally {
        setSession(null);
      }
    },
    async verifyAdmin() {
      if (!(await session())) return null;
      const user = await authorized('/auth/v1/user');
      const rows = await authorized(
        '/rest/v1/site_admins?select=user_id&user_id=eq.' + encodeURIComponent(user.id)
      );
      if (!rows.length) {
        setSession(null);
        throw new Error(
          '이 계정에는 관리 권한이 없습니다. Supabase에서 관리자 계정을 등록해 주세요.'
        );
      }
      return user;
    },
    async saveProject(project, creating) {
      const row = {
        name: project.name,
        category: project.category,
        description: project.description,
        status: project.status,
        tags: project.tags,
        note: project.note,
        url: project.url,
        image_url: project.imageUrl,
        show_in_projects: project.showInProjects,
        is_published: project.isPublished,
        sort_order: project.sortOrder
      };
      if (creating) row.id = project.id;
      const rows = await authorized(
        '/rest/v1/projects' + (creating ? '' : '?id=eq.' + encodeURIComponent(project.id)),
        {
          method: creating ? 'POST' : 'PATCH',
          body: row,
          headers: { Prefer: 'return=representation' }
        }
      );
      if (rows?.length !== 1)
        throw new Error('저장 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
      return projectFromRow(rows[0]);
    },
    async saveEntry(entry, creating) {
      const row = {
        project_id: entry.projectId,
        date: entry.date,
        title: entry.title,
        summary: entry.summary,
        body: entry.body,
        is_published: entry.isPublished
      };
      const rows = await authorized(
        '/rest/v1/journal_entries' + (creating ? '' : '?id=eq.' + encodeURIComponent(entry.id)),
        {
          method: creating ? 'POST' : 'PATCH',
          body: row,
          headers: { Prefer: 'return=representation' }
        }
      );
      if (rows?.length !== 1)
        throw new Error('저장 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
      return entryFromRow(rows[0]);
    },
    async remove(type, id) {
      if (!['projects', 'journal_entries'].includes(type))
        throw new Error('삭제 대상이 올바르지 않습니다.');
      const rows = await authorized('/rest/v1/' + type + '?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' }
      });
      if (rows?.length !== 1)
        throw new Error('삭제 대상이 없거나 권한이 없습니다. 목록을 새로고침해 주세요.');
    }
  };

  const api = window.WorkspaceBackend;
  const rpc = (name, body = {}, admin = false) =>
    (admin ? authorized : request)('/rest/v1/rpc/' + name, { method: 'POST', body });
  let detectedVersion;
  async function version() {
    if (detectedVersion) return detectedVersion;
    try {
      detectedVersion = Number(await rpc('workspace_version'));
    } catch (error) {
      if (error.status === 404 && error.code === 'PGRST202') detectedVersion = 1;
      else throw error;
    }
    return detectedVersion;
  }
  const mediaCache = new Map();
  const preparedImports = new Map();
  function checkImage(file, bytes) {
    if (file.size > 5 * 1024 * 1024) throw new Error('이미지는 한 장당 5MB 이하로 선택해 주세요.');
    const b = new Uint8Array(bytes),
      text = new TextDecoder().decode(b.slice(0, 12));
    const valid =
      file.type === 'image/png'
        ? b[0] === 137 && text.slice(1, 4) === 'PNG'
        : file.type === 'image/jpeg'
          ? b[0] === 255 && b[1] === 216 && b[2] === 255
          : file.type === 'image/webp'
            ? text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP'
            : file.type === 'image/gif'
              ? text.startsWith('GIF8')
              : false;
    if (!valid) throw new Error('PNG, JPG, WEBP, GIF 형식의 이미지 파일을 선택해 주세요.');
  }
  async function mediaFetch(path, { method = 'GET', file, admin = false } = {}) {
    if (!/^uploads\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(path))
      throw new Error('이미지 파일 경로가 올바르지 않습니다.');
    const auth = admin ? await session() : null;
    if (admin && !auth) throw new Error('먼저 로그인해 주세요.');
    const response = await fetch(
      base +
        '/storage/v1/object/' +
        (method === 'GET' ? 'authenticated/' : '') +
        'workspace-media/' +
        path.split('/').map(encodeURIComponent).join('/'),
      {
        method,
        headers: {
          apikey: key,
          ...(auth ? { Authorization: 'Bearer ' + auth.access_token } : {}),
          ...(file ? { 'Content-Type': file.type } : {})
        },
        body: file,
        signal: AbortSignal.timeout(30000)
      }
    );
    if (!response.ok)
      throw new Error(
        '이미지 저장소에 접근하지 못했습니다. 연결 설정과 파일 공개 상태를 확인해 주세요.'
      );
    return response;
  }
  Object.assign(api, {
    version,
    async legacyList(kind) {
      const table = kind === 'project' ? 'projects' : 'journal_entries',
        rows = [];
      for (let offset = 0; ; offset += 100) {
        const page = await request(
          '/rest/v1/' +
            table +
            '?select=*&is_published=eq.true&order=' +
            (kind === 'project' ? 'sort_order.asc,id.asc' : 'date.desc,id.desc') +
            '&limit=100&offset=' +
            offset
        );
        rows.push(...page);
        if (page.length < 100) break;
      }
      return kind === 'project' ? rows.map(projectFromRow) : rows.map(entryFromRow);
    },
    async adminItems() {
      const items = [];
      let offset = 0,
        total = 0;
      do {
        const page = await rpc('workspace_admin_list', { p_offset: offset, p_limit: 100 }, true);
        items.push(...page.items);
        total = page.total;
        offset += page.items.length;
        if (!page.items.length) break;
      } while (offset < total);
      return items;
    },
    publicList(kind, offset = 0, { projectId = null, status = null, limit = 12 } = {}) {
      return rpc('workspace_public_list', {
        p_kind: kind,
        p_offset: offset,
        p_limit: limit,
        p_project_id: projectId,
        p_status: status
      });
    },
    publicDetail(kind, id) {
      return rpc('workspace_public_detail', { p_kind: kind, p_id: id });
    },
    catalog() {
      return rpc('workspace_catalog');
    },
    saveItem({ kind, id, revision, data, publish, requestId }) {
      return rpc(
        'workspace_save',
        {
          p_kind: kind,
          p_id: id,
          p_expected_revision: revision,
          p_data: data,
          p_publish: publish,
          p_request_id: requestId
        },
        true
      );
    },
    itemAction(item, action, requestId, historyId = null) {
      return rpc(
        'workspace_action',
        {
          p_kind: item.kind,
          p_id: item.id,
          p_revision: item.revision,
          p_action: action,
          p_request_id: requestId,
          p_history_id: historyId
        },
        true
      );
    },
    history(item, offset = 0) {
      return rpc(
        'workspace_item_history',
        { p_kind: item.kind, p_id: item.id, p_offset: offset },
        true
      );
    },
    async uploadImage(file) {
      const bytes = await file.arrayBuffer();
      checkImage(file, bytes);
      const ext = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif'
      }[file.type];
      const path = 'uploads/' + crypto.randomUUID() + '.' + ext;
      await mediaFetch(path, { method: 'POST', file, admin: true });
      return 'storage:' + path;
    },
    async resolveImage(value, admin = false) {
      if (value?.startsWith('https://')) return value;
      if (!value?.startsWith('storage:')) return '';
      const cacheKey = (admin ? 'admin:' : 'public:') + value;
      if (!mediaCache.has(cacheKey))
        mediaCache.set(
          cacheKey,
          mediaFetch(value.slice(8), { admin })
            .then((r) => r.blob())
            .then((blob) => URL.createObjectURL(blob))
            .catch((error) => {
              mediaCache.delete(cacheKey);
              throw error;
            })
        );
      return mediaCache.get(cacheKey);
    },
    async exportBackup(progress = () => {}) {
      const backup = await rpc('workspace_export', {}, true),
        paths = new Set();
      function walk(value) {
        if (typeof value === 'string' && value.startsWith('storage:')) paths.add(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      }
      walk(backup);
      backup.media = [];
      let count = 0;
      for (const value of paths) {
        const blob = await (await mediaFetch(value.slice(8), { admin: true })).blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        backup.media.push({ path: value, type: blob.type, base64: btoa(binary) });
        progress(++count, paths.size);
      }
      return backup;
    },
    async importBackup(backup, requestId) {
      if (
        backup.format !== 'wanderer-workspace' ||
        backup.version !== 2 ||
        !Array.isArray(backup.items) ||
        backup.items.length > 10000
      )
        throw new Error('작업실에서 내보낸 백업 파일을 선택해 주세요.');
      if (preparedImports.has(requestId))
        return rpc(
          'workspace_import',
          { p_backup: preparedImports.get(requestId), p_request_id: requestId },
          true
        );
      const copy = structuredClone(backup),
        mappings = new Map();
      for (const media of copy.media || []) {
        if (!media.path?.startsWith('storage:') || typeof media.base64 !== 'string')
          throw new Error('백업 이미지 형식이 올바르지 않습니다.');
        const bytes = Uint8Array.from(atob(media.base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'backup-image', { type: media.type });
        mappings.set(media.path, await api.uploadImage(file));
      }
      delete copy.media;
      delete copy.history;
      function replace(value) {
        if (typeof value === 'string') return mappings.get(value) || value;
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === 'object')
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
        return value;
      }
      const prepared = replace(copy);
      preparedImports.set(requestId, prepared);
      return rpc('workspace_import', { p_backup: prepared, p_request_id: requestId }, true);
    }
  });
})();
