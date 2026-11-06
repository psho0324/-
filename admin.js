(() => {
  const api = window.WorkspaceBackend;
  const $ = selector => document.querySelector(selector);
  let projects = [], entries = [], canEdit = false, editing = null, pendingDelete = null, busy = false;
  const editor = $('#editor'), form = $('#editor-form');
  function message(text, error = false) {
    $('#notice').textContent = text; $('#notice').hidden = !text; $('#notice').classList.toggle('error', error);
  }
  function errorText(error) {
    return error.name === 'TimeoutError' || error.name === 'TypeError' ? '저장 서비스에 연결하지 못했습니다. 인터넷 연결과 Supabase 설정을 확인하고 다시 시도해 주세요.' : error.message;
  }
  function publishBadge(item) {
    const badge = document.createElement('span');
    badge.className = 'badge' + (item.isPublished === false ? ' draft' : '');
    badge.textContent = item.isPublished === false ? '초안' : '공개'; return badge;
  }
  function render() {
    $('#stat-projects').textContent = projects.length;
    $('#stat-entries').textContent = entries.length;
    $('#stat-drafts').textContent = [...projects, ...entries].filter(item => item.isPublished === false).length;
    const selectedProject = $('#entry-project-filter').value;
    $('#entry-project-filter').replaceChildren(new Option('전체 프로젝트', 'all'), ...projects.map(project => new Option(project.name, project.id)));
    if (projects.some(project => project.id === selectedProject)) $('#entry-project-filter').value = selectedProject;
    for (const [type, list, container] of [['project', projects, $('#project-list')], ['entry', entries.filter(entry => $('#entry-project-filter').value === 'all' || entry.projectId === $('#entry-project-filter').value), $('#entry-list')]]) {
      container.replaceChildren();
      if (!list.length) {
        const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = type === 'project' ? '아직 프로젝트가 없어요. 첫 프로젝트를 추가해 보세요.' : '아직 제작 기록이 없어요. 첫 이야기를 남겨 보세요.'; container.append(empty);
      }
      for (const item of list) {
        const article = document.createElement('article'); article.className = 'admin-item';
        article.innerHTML = '<div class="item-copy"><h3></h3><p></p><div class="item-meta"></div></div><div class="row-actions"><button class="secondary edit">수정</button><button class="secondary delete">삭제</button></div>';
        article.querySelector('h3').textContent = type === 'project' ? item.name : item.title;
        article.querySelector('p').textContent = type === 'project' ? item.description : item.summary;
        const meta = article.querySelector('.item-meta'); meta.append(publishBadge(item));
        const detail = document.createElement('span');
        detail.textContent = type === 'project' ? ((item.status === 'live' ? '사용 가능' : '개발 중') + (item.showInProjects === false ? ' · 기록에만 표시' : '')) : (projects.find(project => project.id === item.projectId)?.name || '프로젝트') + ' · ' + item.date;
        meta.append(detail);
        if (type === 'entry' && projects.find(project => project.id === item.projectId)?.isPublished === false) {
          const hidden = document.createElement('span'); hidden.textContent = '프로젝트가 초안이라 방문자에게 숨겨짐'; meta.append(hidden);
        }
        article.querySelector('.edit').addEventListener('click', () => openEditor(type, item));
        article.querySelector('.delete').addEventListener('click', () => confirmDelete(type, item));
        article.querySelectorAll('button').forEach(button => { button.disabled = !canEdit; });
        container.append(article);
      }
    }
    $('#new-project').disabled = !canEdit;
    $('#new-entry').disabled = !canEdit || !projects.length;
  }
  function activateTab(tab) {
    for (const item of document.querySelectorAll('[role="tab"]')) {
      const selected = item === tab; item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return; event.preventDefault(); activateTab(tabs[next]); tabs[next].focus();
    });
  });
  function setValue(id, value = '') { $('#' + id).value = value; }
  function openEditor(type, item = null) {
    if (!canEdit) return;
    editing = { type, item }; form.reset(); $('#editor-error').hidden = true;
    $('#editor-title').textContent = (type === 'project' ? '프로젝트 ' : '제작 기록 ') + (item ? '수정' : '추가');
    $('#project-fields').hidden = type !== 'project'; $('#entry-fields').hidden = type !== 'entry';
    $('#project-fields').querySelectorAll('input,select,textarea').forEach(input => { input.disabled = type !== 'project'; });
    $('#entry-fields').querySelectorAll('input,select,textarea').forEach(input => { input.disabled = type !== 'entry'; });
    setValue('publish-state', item?.isPublished ? 'published' : 'draft');
    if (type === 'project') {
      for (const [field, value] of Object.entries({ name: item?.name, id: item?.id, category: item?.category, status: item?.status || 'building', description: item?.description, note: item?.note, url: item?.url, image: item?.imageUrl, tags: item?.tags?.join(', '), order: item?.sortOrder || 0 })) setValue('project-' + field, value ?? '');
      $('#project-id').disabled = Boolean(item); $('#project-visible').checked = item?.showInProjects !== false;
    } else {
      $('#entry-project').replaceChildren(...projects.map(project => new Option(project.name, project.id)));
      const filter = $('#entry-project-filter').value;
      setValue('entry-project', item?.projectId || (filter !== 'all' ? filter : projects[0]?.id));
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
      for (const field of ['date', 'title', 'summary', 'body']) setValue('entry-' + field, item?.[field] || (field === 'date' ? today : ''));
    }
    editor.showModal();
  }
  function validUrl(value) { if (!value) return true; try { return new URL(value).protocol === 'https:'; } catch { return false; } }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!canEdit || busy || !form.reportValidity()) return;
    $('#editor-error').hidden = true;
    const val = id => $('#' + id).value.trim();
    let payload;
    try {
      if (editing.type === 'project') {
        if (!validUrl(val('project-url')) || !validUrl(val('project-image'))) throw new Error('앱과 이미지 주소는 https://로 시작하는 주소를 입력해 주세요.');
        const tags = val('project-tags').split(',').map(tag => tag.trim()).filter(Boolean);
        if (tags.length > 10 || tags.some(tag => tag.length > 50)) throw new Error('태그는 10개 이하, 각 50자 이하로 적어 주세요.');
        if (!val('project-name') || !val('project-description')) throw new Error('이름과 소개를 입력해 주세요.');
        payload = { id: editing.item?.id || val('project-id'), name: val('project-name'), category: val('project-category'), description: val('project-description'), status: val('project-status'), note: val('project-note'), url: val('project-url'), imageUrl: val('project-image'), tags, sortOrder: Number(val('project-order')), showInProjects: $('#project-visible').checked, isPublished: val('publish-state') === 'published' };
      } else {
        if (!val('entry-title') || !val('entry-summary') || !val('entry-body')) throw new Error('제목, 요약과 내용을 입력해 주세요.');
        payload = { id: editing.item?.id, projectId: val('entry-project'), date: val('entry-date'), title: val('entry-title'), summary: val('entry-summary'), body: val('entry-body'), isPublished: val('publish-state') === 'published' };
      }
      busy = true; $('#save-item').disabled = true; $('#save-item').textContent = '저장 중…'; editor.querySelectorAll('.close-editor').forEach(button => { button.disabled = true; });
      const saved = await (editing.type === 'project' ? api.saveProject(payload, !editing.item) : api.saveEntry(payload, !editing.item));
      const list = editing.type === 'project' ? projects : entries;
      const index = list.findIndex(item => item.id === saved.id);
      if (index === -1) list.push(saved); else list[index] = saved;
      projects.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id.localeCompare(b.id));
      entries.sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
      render(); editor.close(); message(saved.isPublished ? (window.WORKSPACE_CONFIG.useDatabase ? '저장했습니다. 공개 사이트에 반영됩니다.' : '저장했습니다. 공개 사이트 연결 확인이 끝나면 반영됩니다.') : '초안으로 저장했습니다. 방문자에게는 보이지 않습니다.');
    } catch (error) { $('#editor-error').textContent = errorText(error); $('#editor-error').hidden = false; }
    finally { busy = false; $('#save-item').disabled = false; $('#save-item').textContent = '저장'; editor.querySelectorAll('.close-editor').forEach(button => { button.disabled = false; }); }
  });
  editor.querySelectorAll('.close-editor').forEach(button => button.addEventListener('click', () => { if (!busy) editor.close(); }));
  editor.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  function confirmDelete(type, item) {
    if (!canEdit || busy) return;
    if (type === 'project' && entries.some(entry => entry.projectId === item.id)) { message('이 프로젝트에 제작 기록이 연결되어 있습니다. 기록을 먼저 다른 프로젝트로 옮기거나 삭제해 주세요. 공개만 멈추려면 프로젝트를 초안으로 바꿀 수 있어요.', true); return; }
    pendingDelete = { type, item }; $('#delete-error').hidden = true;
    $('#delete-message').textContent = '“' + (type === 'project' ? item.name : item.title) + '” 항목을 삭제합니다.';
    $('#delete-dialog').showModal();
  }
  $('#cancel-delete').addEventListener('click', () => { if (!busy) $('#delete-dialog').close(); });
  $('#delete-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('#confirm-delete').addEventListener('click', async () => {
    if (!canEdit || busy || !pendingDelete) return;
    busy = true; $('#confirm-delete').disabled = true; $('#cancel-delete').disabled = true;
    try {
      await api.remove(pendingDelete.type === 'project' ? 'projects' : 'journal_entries', pendingDelete.item.id);
      if (pendingDelete.type === 'project') projects = projects.filter(item => item.id !== pendingDelete.item.id); else entries = entries.filter(item => item.id !== pendingDelete.item.id);
      render(); $('#delete-dialog').close(); message('삭제했습니다.');
    } catch (error) { $('#delete-error').textContent = errorText(error); $('#delete-error').hidden = false; }
    finally { busy = false; $('#confirm-delete').disabled = false; $('#cancel-delete').disabled = false; }
  });
  $('#new-project').addEventListener('click', () => openEditor('project'));
  $('#new-entry').addEventListener('click', () => openEditor('entry'));
  $('#entry-project-filter').addEventListener('change', render);
  function showLogin() { canEdit = false; projects = []; entries = []; render(); $('#dashboard').hidden = true; $('#login-panel').hidden = false; $('#logout').hidden = true; }
  async function loadDashboard() {
    const user = await api.verifyAdmin();
    if (!user) { showLogin(); return; }
    const data = await api.load(true); projects = data.projects; entries = data.entries; canEdit = true;
    $('#login-panel').hidden = true; $('#dashboard').hidden = false; $('#logout').hidden = false;
    $('#account-label').textContent = user.email + ' · 관리자' + (window.WORKSPACE_CONFIG.useDatabase ? '' : ' · 공개 데이터 연결 대기'); render();
  }
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; message('로그인 확인 중…');
    try { await api.login($('#login-email').value.trim(), $('#login-password').value); $('#login-password').value = ''; await loadDashboard(); message(''); }
    catch (error) { message(errorText(error), true); showLogin(); }
    finally { button.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => {
    $('#logout').disabled = true;
    try { await api.logout(); message('로그아웃했습니다.'); }
    catch { message('이 브라우저에서 로그아웃했습니다. 서버 연결은 확인하지 못했습니다.', true); }
    finally { $('#logout').disabled = false; showLogin(); }
  });
  if (!api.configured || api.configurationError) {
    projects = window.projects.map(project => ({ ...project, isPublished: true }));
    entries = window.journalEntries.map(entry => ({ ...entry, isPublished: true }));
    $('#setup-panel').hidden = false; $('#dashboard').hidden = false; render();
    if (api.configurationError) message(api.configurationError, true);
  } else {
    message('관리자 계정을 확인하고 있습니다…');
    loadDashboard().then(() => message('')).catch(error => { showLogin(); message(errorText(error), true); });
  }
})();
