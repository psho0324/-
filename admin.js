(() => {
  const api = window.WorkspaceBackend;
  const $ = selector => document.querySelector(selector);
  let projects = [], entries = [], canEdit = false, editing = null, pendingDelete = null, busy = false;
  const categories = window.PROJECT_CATEGORIES;
  const categoryLabel = value => categories.find(category => category.value === value)?.label || value || '기타';
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
    const draftItems = [
      ...projects.filter(item => item.isPublished === false).map(item => ({ type: 'project', item })),
      ...entries.filter(item => item.isPublished === false).map(item => ({ type: 'entry', item }))
    ];
    $('#draft-tab-count').textContent = draftItems.length;
    function renderItems(container, items, emptyText) {
      container.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = emptyText; container.append(empty);
      }
      for (const { type, item } of items) {
        const article = document.createElement('article'); article.className = 'admin-item';
        article.innerHTML = '<div class="item-copy"><h3></h3><p></p><div class="item-meta"></div></div><div class="row-actions"><button class="secondary edit">수정</button><button class="secondary delete">삭제</button></div>';
        article.querySelector('h3').textContent = type === 'project' ? item.name : item.title;
        article.querySelector('p').textContent = type === 'project' ? item.description : item.summary;
        const meta = article.querySelector('.item-meta'); meta.append(publishBadge(item));
        const detail = document.createElement('span');
        detail.textContent = type === 'project' ? '프로젝트 · ' + categoryLabel(item.category) + ' · ' + (item.status === 'live' ? '사용 가능' : '개발 중') + (item.showInProjects === false ? ' · 기록에만 표시' : '') : '제작 기록 · ' + (projects.find(project => project.id === item.projectId)?.name || '프로젝트') + ' · ' + item.date;
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
    renderItems($('#project-list'), projects.map(item => ({ type: 'project', item })), '아직 프로젝트가 없어요. 첫 프로젝트를 추가해 보세요.');
    renderItems($('#entry-list'), entries.filter(entry => $('#entry-project-filter').value === 'all' || entry.projectId === $('#entry-project-filter').value).map(item => ({ type: 'entry', item })), '아직 제작 기록이 없어요. 첫 이야기를 남겨 보세요.');
    renderItems($('#draft-list'), draftItems, '보관 중인 초안이 없어요. 프로젝트 초안이나 기록 초안으로 새로운 이야기를 시작해 보세요.');
    $('#new-project').disabled = $('#new-draft-project').disabled = !canEdit;
    $('#new-entry').disabled = $('#new-draft-entry').disabled = !canEdit || !projects.length;
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
  function updateSaveLabel() {
    $('#save-item').textContent = $('#publish-state').value === 'draft' ? '초안 저장' : '공개 저장';
  }
  function updateDescriptionCount() { $('#description-count').textContent = $('#project-description').value.length + ' / 500'; }
  $('#publish-state').addEventListener('change', updateSaveLabel);
  $('#project-description').addEventListener('input', updateDescriptionCount);
  function openEditor(type, item = null) {
    if (!canEdit) return;
    editing = { type, item }; form.reset(); $('#editor-error').hidden = true;
    $('#editor-title').textContent = (type === 'project' ? '프로젝트 ' : '제작 기록 ') + (item ? '수정' : '추가');
    $('#project-fields').hidden = type !== 'project'; $('#entry-fields').hidden = type !== 'entry';
    $('#project-fields').querySelectorAll('input,select,textarea').forEach(input => { input.disabled = type !== 'project'; });
    $('#entry-fields').querySelectorAll('input,select,textarea').forEach(input => { input.disabled = type !== 'entry'; });
    setValue('publish-state', item?.isPublished ? 'published' : 'draft');
    if (type === 'project') {
      const category = item?.category ?? 'OTHER';
      const categoryOptions = categories.map(option => new Option(option.label, option.value));
      if (!categories.some(option => option.value === category)) categoryOptions.push(new Option('기존 분류: ' + (category || '미지정'), category));
      $('#project-category').replaceChildren(...categoryOptions);
      $('#project-advanced').open = false;
      for (const [field, value] of Object.entries({ name: item?.name, id: item?.id || 'project-' + crypto.randomUUID(), category, status: item?.status || 'building', description: item?.description, note: item?.note, url: item?.url, image: item?.imageUrl, tags: item?.tags?.join(', '), order: item?.sortOrder || 0 })) setValue('project-' + field, value ?? '');
      $('#project-id').disabled = Boolean(item); $('#project-visible').checked = item?.showInProjects !== false;
    } else {
      $('#entry-project').replaceChildren(...projects.map(project => new Option(project.name, project.id)));
      const filter = $('#entry-project-filter').value;
      setValue('entry-project', item?.projectId || (filter !== 'all' ? filter : projects[0]?.id));
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
      for (const field of ['date', 'title', 'summary', 'body']) setValue('entry-' + field, item?.[field] || (field === 'date' ? today : ''));
    }
    updateDescriptionCount(); updateSaveLabel();
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
    finally { busy = false; $('#save-item').disabled = false; updateSaveLabel(); editor.querySelectorAll('.close-editor').forEach(button => { button.disabled = false; }); }
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
  $('#open-drafts').addEventListener('click', () => { activateTab($('#manage-drafts')); $('#manage-drafts').focus(); });
  $('#new-draft-project').addEventListener('click', () => openEditor('project'));
  $('#new-draft-entry').addEventListener('click', () => openEditor('entry'));
  $('#new-entry').addEventListener('click', () => openEditor('entry'));
  $('#entry-project-filter').addEventListener('change', render);
  function showLogin() { $('#recovery-panel').hidden = true; canEdit = false; projects = []; entries = []; render(); $('#dashboard').hidden = true; $('#login-panel').hidden = false; $('#logout').hidden = true; }
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
  $('#request-reset').addEventListener('click', async () => {
    const email = $('#login-email');
    if (!email.reportValidity()) { email.focus(); return; }
    const button = $('#request-reset'); button.disabled = true;
    message('재설정 이메일을 요청하고 있습니다…');
    try {
      await api.sendPasswordReset(email.value.trim());
      message('등록된 계정이라면 재설정 이메일이 발송됩니다. 메일의 링크에서 새 비밀번호를 정해 주세요. 스팸함도 확인해 주세요.');
    } catch (error) { message(errorText(error), true); }
    finally { button.disabled = false; }
  });
  $('#recovery-form').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('#new-password').value;
    if (password !== $('#confirm-password').value) { message('새 비밀번호와 확인 입력이 서로 다릅니다.', true); return; }
    if (!password.trim()) { message('공백으로만 된 비밀번호는 사용할 수 없습니다.', true); return; }
    const button = event.submitter; button.disabled = true; message('비밀번호를 변경하고 있습니다…');
    try {
      await api.updatePassword(password);
      $('#recovery-form').reset(); $('#login-password').value = '';
      showLogin(); message('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.');
    } catch (error) { message(errorText(error), true); }
    finally { button.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => {
    $('#logout').disabled = true;
    try { await api.logout(); message('로그아웃했습니다.'); }
    catch { message('이 브라우저에서 로그아웃했습니다. 서버 연결은 확인하지 못했습니다.', true); }
    finally { $('#logout').disabled = false; showLogin(); }
  });
  // 이메일 링크를 이미 열린 관리자 탭으로 열어도 복구 화면을 초기화합니다.
  window.addEventListener('hashchange', () => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get('type') === 'recovery' || hash.has('error') || hash.has('error_code')) window.location.reload();
  });
  if (!api.configured || api.configurationError) {
    projects = window.projects.map(project => ({ ...project, isPublished: true }));
    entries = window.journalEntries.map(entry => ({ ...entry, isPublished: true }));
    $('#setup-panel').hidden = false; $('#dashboard').hidden = false; render();
    if (api.configurationError) message(api.configurationError, true);
  } else {
    try {
      if (api.consumeRecoveryLink()) {
        message('재설정 링크를 확인하고 있습니다…');
        api.verifyRecovery().then(() => { $('#login-panel').hidden = true; $('#dashboard').hidden = true; $('#recovery-panel').hidden = false; message(''); $('#new-password').focus(); })
          .catch(error => { showLogin(); message(errorText(error), true); });
      } else {
        message('관리자 계정을 확인하고 있습니다…');
        loadDashboard().then(() => message('')).catch(error => { showLogin(); message(errorText(error), true); });
      }
    } catch (error) { showLogin(); message(errorText(error), true); }
  }
})();
