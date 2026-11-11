(() => {
  const api = window.WorkspaceBackend,
    $ = (s) => document.querySelector(s),
    categories = window.PROJECT_CATEGORIES;
  const names = { project: '프로젝트', entry: '제작 기록', idea: '다음 실험' };
  let items = [],
    user = null,
    editing = null,
    baseline = '',
    busy = false,
    uploading = false,
    images = [],
    pendingAction = null,
    lastSave = null,
    historyState = null,
    restoreFile = null,
    restoreId = null;
  const editor = $('#editor'),
    form = $('#editor-form');
  const dataOf = (item) => item.draft || item.published || {};
  const titleOf = (item) => dataOf(item).name || dataOf(item).title || '(제목 없음)';
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value || '';
    if (className) el.className = className;
    return el;
  };
  function message(value, error = false) {
    $('#notice').textContent = value;
    $('#notice').hidden = !value;
    $('#notice').classList.toggle('error', error);
  }
  function errorText(e) {
    return e.name === 'TypeError' || e.name === 'TimeoutError'
      ? '연결이 불안정합니다. 작성 내용은 이 브라우저에 보관했습니다. 다시 시도해 주세요.'
      : e.message;
  }
  function activateTab(tab) {
    document.querySelectorAll('[role=tab]').forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', selected);
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
  }
  const tabs = [...document.querySelectorAll('[role=tab]')];
  tabs.forEach((tab, i) => {
    tab.onclick = () => activateTab(tab);
    tab.onkeydown = (e) => {
      const n =
        e.key === 'ArrowRight'
          ? (i + 1) % tabs.length
          : e.key === 'ArrowLeft'
            ? (i + tabs.length - 1) % tabs.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? tabs.length - 1
                : null;
      if (n === null) return;
      e.preventDefault();
      activateTab(tabs[n]);
      tabs[n].focus();
    };
  });
  function localKey() {
    return 'wanderer-editor-v2:' + user?.id;
  }
  function snapshot() {
    return Object.fromEntries(
      [...form.querySelectorAll('input[id],select[id],textarea[id]')]
        .filter((el) => el.type !== 'file')
        .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value])
    );
  }
  function dirty() {
    return !!editing && JSON.stringify({ values: snapshot(), images }) !== baseline;
  }
  function saveLocal() {
    if (!user || !editing) return;
    if (!dirty()) {
      // Reverting this item's edits must not leave an older temporary revision.
      // A temporary draft for a different item remains available.
      try {
        const saved = JSON.parse(localStorage.getItem(localKey()));
        if (saved?.editing?.kind === editing.kind && saved.editing.id === editing.id) {
          clearLocal();
          $('#local-save-status').textContent = '';
        }
      } catch { /* Keep unreadable temporary data for explicit discard. */ }
      return;
    }
    try {
      localStorage.setItem(
        localKey(),
        JSON.stringify({ editing, values: snapshot(), images, lastSave, savedAt: Date.now() })
      );
      $('#local-save-status').textContent = '작성 중인 내용을 이 브라우저에 임시 보관했습니다.';
    } catch {
      $('#local-save-status').textContent =
        '이 브라우저에 임시 보관하지 못했습니다. 창을 닫기 전에 저장해 주세요.';
    }
  }
  function resumeBanner() {
    let exists = false;
    try {
      exists = !!user && !!localStorage.getItem(localKey());
    } catch {}
    $('#resume-banner').hidden = !exists;
  }
  function clearLocal() {
    try {
      localStorage.removeItem(localKey());
    } catch {}
    resumeBanner();
  }
  function requestClose() {
    if (busy || uploading) return;
    if (dirty() && !confirm('저장하지 않은 내용이 있습니다. 이 브라우저에 임시 보관하고 닫을까요?'))
      return;
    saveLocal();
    editor.close();
    resumeBanner();
  }
  form.addEventListener('input', () => {
    lastSave = null;
    updateCount();
    saveLocal();
  });
  form.addEventListener('change', () => {
    lastSave = null;
    updateCount();
    saveLocal();
  });
  window.addEventListener('beforeunload', (e) => {
    if (editor.open && dirty()) {
      saveLocal();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  editor.addEventListener('cancel', (e) => {
    e.preventDefault();
    requestClose();
  });
  editor.querySelectorAll('.close-editor').forEach((button) => (button.onclick = requestClose));
  function updateCount() {
    $('#description-count').textContent = $('#project-description').value.length + ' / 500';
    $('#save-item').textContent =
      $('#publish-state').value === 'draft' ? '수정 초안 저장' : '공개 저장';
  }
  function renderAttachments() {
    const container = $('#entry-images');
    container.replaceChildren();
    images.forEach((value, i) => {
      const row = text('div', '', 'attachment');
      row.append(text('span', '첨부 이미지 ' + (i + 1)));
      const remove = text('button', '첨부 취소', 'text-button');
      remove.type = 'button';
      remove.onclick = () => {
        images.splice(i, 1);
        renderAttachments();
        lastSave = null;
        saveLocal();
      };
      row.append(remove);
      container.append(row);
    });
  }
  function fill(kind, item, values) {
    editing = {
      kind,
      id: item?.id || kind + '-' + crypto.randomUUID(),
      revision: item?.revision || 0
    };
    images = [...(values.images || [])];
    form.reset();
    lastSave = null;
    $('#editor-error').hidden = true;
    $('#copy-conflict').hidden = true;
    $('#local-save-status').textContent = '';
    $('#upload-status').textContent = '';
    $('#editor-title').textContent = names[kind] + ' ' + (item ? '수정' : '추가');
    for (const k of ['project', 'entry', 'idea']) {
      const group = $('#' + k + '-fields');
      group.hidden = k !== kind;
      group.querySelectorAll('input,textarea,select').forEach((el) => (el.disabled = k !== kind));
    }
    $('#project-category').replaceChildren(...categories.map((c) => new Option(c.label, c.value)));
    if (values.category !== undefined && !categories.some((c) => c.value === values.category))
      $('#project-category').append(new Option('기존 분류: ' + values.category, values.category));
    const projects = items.filter((i) => i.kind === 'project' && !i.deleted_at);
    $('#entry-project').replaceChildren(...projects.map((p) => new Option(titleOf(p), p.id)));
    const set = (id, value) => {
      $('#' + id).value = value ?? '';
    };
    const fields =
      kind === 'project'
        ? {
            name: values.name,
            id: editing.id,
            category: values.category || 'OTHER',
            status: values.status || 'building',
            description: values.description,
            note: values.note,
            url: values.url,
            image: values.imageUrl,
            tags: (values.tags || []).join(', '),
            order: values.sortOrder || 0
          }
        : kind === 'entry'
          ? {
              project:
                values.projectId ||
                projects.find((p) => dataOf(p).showInProjects !== false)?.id ||
                projects[0]?.id,
              date:
                values.date ||
                new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()),
              title: values.title,
              summary: values.summary,
              body: values.body
            }
          : { title: values.title, summary: values.summary, stage: values.stage || 'idea' };
    Object.entries(fields).forEach(([key, value]) => set(kind + '-' + key, value));
    $('#project-visible').checked = values.showInProjects !== false;
    $('#download-platform').value = ['pc', 'windows', 'macos', 'linux'].includes(
      values.downloadPlatform
    )
      ? values.downloadPlatform
      : 'pc';
    $('#download-url').value = values.downloadUrl || '';
    $('#download-version').value = values.downloadVersion || '';
    $('#download-requirements').value = values.downloadRequirements || '';
    $('#download-mobile-planned').checked = values.mobilePlanned ?? item?.id === 'calendar';
    $('#project-id').disabled = !!item || kind !== 'project';
    $('#project-advanced').open = false;
    $('#publish-state').value = item?.published && !item?.draft ? 'published' : 'draft';
    renderAttachments();
    updateCount();
    baseline = JSON.stringify({ values: snapshot(), images });
  }
  function openEditor(kind, item = null) {
    if (!user) return;
    let stored = false;
    try {
      stored = !!localStorage.getItem(localKey());
    } catch {}
    if (
      stored &&
      !confirm(
        '임시 보관한 작성 내용이 있습니다. 새 편집을 시작하면 임시 내용이 바뀔 수 있습니다. 계속할까요?'
      )
    )
      return;
    fill(kind, item, item ? dataOf(item) : {});
    editor.showModal();
  }
  $('#resume-editor').onclick = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(localKey()));
      if (!stored) return;
      const match = items.find((i) => i.kind === stored.editing.kind && i.id === stored.editing.id);
      fill(stored.editing.kind, match, match ? dataOf(match) : {});
      editing = stored.editing;
      Object.entries(stored.values).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) {
          if (el.type === 'checkbox') el.checked = value;
          else el.value = value;
        }
      });
      images = stored.images || [];
      lastSave = stored.lastSave;
      renderAttachments();
      updateCount();
      editor.showModal();
    } catch {
      message('임시 내용을 읽지 못했습니다. 임시 내용 지우기 후 다시 작성해 주세요.', true);
    }
  };
  $('#discard-local').onclick = () => {
    if (confirm('이 브라우저에 임시 보관된 작성 내용을 지울까요?')) clearLocal();
  };
  function readPayload() {
    const val = (id) => $('#' + id).value.trim();
    const kind = editing.kind;
    let data;
    if (kind === 'project') {
      const id = editing.revision ? editing.id : val('project-id');
      if (!/^[a-z0-9](?:[a-z0-9]|-){0,59}$/.test(id))
        throw Error('관리용 ID는 영문 소문자·숫자·하이픈으로 60자 이하로 입력해 주세요.');
      editing.id = id;
      const tags = val('project-tags')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length > 10 || tags.some((t) => t.length > 50))
        throw Error('태그는 최대 10개, 각 50자 이하로 적어 주세요.');
      if (val('project-url') && !/^https:\/\//.test(val('project-url')))
        throw Error('앱 주소는 https://로 시작해야 합니다.');
      const downloadUrl = val('download-url');
      if (downloadUrl) {
        let valid = false;
        try {
          const parsed = new URL(downloadUrl);
          valid = parsed.protocol === 'https:' && !parsed.username && !parsed.password;
        } catch {}
        if (!valid) throw Error('다운로드 주소는 https://로 시작하는 주소를 입력해 주세요.');
      }
      const image = val('project-image');
      if (image && !image.startsWith('storage:') && !/^https:\/\//.test(image))
        throw Error('이미지 주소는 https://를 사용하거나 파일을 업로드해 주세요.');
      data = {
        name: val('project-name'),
        category: val('project-category'),
        description: val('project-description'),
        status: val('project-status'),
        tags,
        note: val('project-note'),
        url: val('project-url'),
        downloadUrl,
        downloadPlatform: val('download-platform'),
        downloadVersion: val('download-version'),
        downloadRequirements: val('download-requirements'),
        mobilePlanned: $('#download-mobile-planned').checked,
        imageUrl: image,
        sortOrder: Number(val('project-order')),
        showInProjects: $('#project-visible').checked
      };
    } else if (kind === 'entry')
      data = {
        projectId: val('entry-project'),
        date: val('entry-date'),
        title: val('entry-title'),
        summary: val('entry-summary'),
        body: val('entry-body'),
        images: [...images]
      };
    else
      data = { title: val('idea-title'), summary: val('idea-summary'), stage: val('idea-stage') };
    return {
      kind,
      id: editing.id,
      revision: editing.revision,
      data,
      publish: $('#publish-state').value === 'published'
    };
  }
  function replaceItem(item) {
    const index = items.findIndex((i) => i.kind === item.kind && i.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = item;
    render();
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy || uploading || !form.reportValidity()) return;
    $('#editor-error').hidden = true;
    try {
      const payload = readPayload();
      const fingerprint = JSON.stringify(payload);
      if (!lastSave || lastSave.fingerprint !== fingerprint)
        lastSave = { fingerprint, requestId: crypto.randomUUID() };
      saveLocal();
      busy = true;
      form.inert = true;
      $('#save-item').textContent = '저장 중…';
      const item = await api.saveItem({ ...payload, requestId: lastSave.requestId });
      replaceItem(item);
      clearLocal();
      editing = null;
      editor.close();
      message(
        payload.publish
          ? '공개본에 반영했습니다.'
          : '수정 초안을 저장했습니다. 기존 공개본은 유지됩니다.'
      );
    } catch (error) {
      $('#editor-error').textContent = errorText(error);
      $('#editor-error').hidden = false;
      $('#copy-conflict').hidden = error.code !== 'PT409';
      if (error.code === 'PT409') {
        try {
          items = await api.adminItems();
          render();
        } catch {}
      }
      saveLocal();
    } finally {
      busy = false;
      form.inert = false;
      updateCount();
    }
  };
  $('#copy-conflict').onclick = () => {
    editing.id = editing.kind + '-' + crypto.randomUUID();
    editing.revision = 0;
    $('#project-id').value = editing.id;
    $('#project-id').disabled = editing.kind !== 'project';
    $('#publish-state').value = 'draft';
    lastSave = null;
    $('#copy-conflict').hidden = true;
    $('#editor-error').hidden = true;
    updateCount();
    saveLocal();
  };
  $('#project-upload').onchange = async (e) => {
    if (!e.target.files[0]) return;
    uploading = true;
    $('#save-item').disabled = true;
    $('#upload-status').textContent = '이미지 업로드 중…';
    try {
      $('#project-image').value = await api.uploadImage(e.target.files[0]);
      lastSave = null;
      saveLocal();
      $('#upload-status').textContent = '대표 이미지를 첨부했습니다. 저장 후 적용됩니다.';
    } catch (error) {
      $('#upload-status').textContent = errorText(error);
    } finally {
      uploading = false;
      $('#save-item').disabled = false;
      e.target.value = '';
    }
  };
  $('#entry-upload').onchange = async (e) => {
    const files = [...e.target.files];
    if (images.length + files.length > 10) {
      message('첨부 이미지는 최대 10장입니다.', true);
      e.target.value = '';
      return;
    }
    uploading = true;
    $('#save-item').disabled = true;
    try {
      for (const file of files) {
        $('#upload-status').textContent = '이미지 업로드 중…';
        images.push(await api.uploadImage(file));
        renderAttachments();
        saveLocal();
      }
      $('#upload-status').textContent = '이미지를 첨부했습니다. 저장 후 적용됩니다.';
    } catch (error) {
      $('#upload-status').textContent = errorText(error);
    } finally {
      uploading = false;
      $('#save-item').disabled = false;
      e.target.value = '';
    }
  };
  $('#preview-item').onclick = async () => {
    if (!form.reportValidity()) return;
    try {
      const { kind, data } = readPayload();
      $('#preview-title').textContent = data.name || data.title;
      const container = $('#preview-content');
      container.replaceChildren(
        text('p', data.description || data.summary),
        text('p', data.note || data.body || '')
      );
      for (const value of [data.imageUrl, ...(data.images || [])].filter(Boolean)) {
        const image = new Image();
        image.alt = '미리보기 이미지';
        image.src = await api.resolveImage(value, true);
        container.append(image);
      }
      $('#preview-dialog').showModal();
    } catch (error) {
      message(errorText(error), true);
    }
  };
  $('#close-preview').onclick = () => $('#preview-dialog').close();
  const pageNumbers = {};
  function render() {
    const active = items.filter((i) => !i.deleted_at),
      projects = active.filter((i) => i.kind === 'project'),
      entries = active.filter((i) => i.kind === 'entry'),
      drafts = active.filter((i) => i.draft);
    $('#stat-projects').textContent = projects.length;
    $('#stat-entries').textContent = entries.length;
    $('#stat-drafts').textContent = drafts.length;
    $('#draft-tab-count').textContent = drafts.length;
    const filter = $('#entry-project-filter').value;
    $('#entry-project-filter').replaceChildren(
      new Option('전체 프로젝트', ''),
      ...projects.map((i) => new Option(titleOf(i), i.id))
    );
    $('#entry-project-filter').value = projects.some((p) => p.id === filter) ? filter : '';
    const collections = {
      'project-list': projects,
      'entry-list': entries.filter(
        (e) =>
          !$('#entry-project-filter').value ||
          dataOf(e).projectId === $('#entry-project-filter').value
      ),
      'draft-list': drafts,
      'idea-admin-list': active.filter((i) => i.kind === 'idea'),
      'trash-list': items.filter((i) => i.deleted_at)
    };
    for (const [id, list] of Object.entries(collections)) {
      const container = $('#' + id);
      container.replaceChildren();
      let page = pageNumbers[id] || 0;
      page = Math.min(page, Math.max(0, Math.ceil(list.length / 20) - 1));
      pageNumbers[id] = page;
      if (!list.length)
        container.append(
          text(
            'p',
            id === 'trash-list' ? '휴지통이 비어 있습니다.' : '아직 등록된 항목이 없습니다.',
            'empty-list'
          )
        );
      for (const item of list.slice(page * 20, page * 20 + 20)) {
        const data = dataOf(item),
          article = text('article', '', 'admin-item'),
          copy = text('div', '', 'item-copy');
        copy.append(text('h3', titleOf(item)), text('p', data.description || data.summary || ''));
        article.dataset.itemId = item.id;
        article.dataset.kind = item.kind;
        const badge = item.deleted_at
          ? '휴지통'
          : item.published
            ? item.draft
              ? '공개 중 · 수정 초안 있음'
              : '공개 중'
            : '초안';
        copy.append(
          text('span', names[item.kind] + ' · ' + badge + ' · 버전 ' + item.revision, 'badge')
        );
        const actions = text('div', '', 'row-actions');
        function button(label, fn, cls) {
          const b = text('button', label, 'secondary ' + (cls || ''));
          b.onclick = fn;
          actions.append(b);
        }
        if (item.deleted_at) button('복원', () => queueAction(item, 'restore'));
        else {
          button('수정', () => openEditor(item.kind, item), 'edit');
          button('휴지통', () => queueAction(item, 'trash'), 'delete');
          button('이력', () => showHistory(item), 'history');
          if (item.published) button('공개 중지', () => queueAction(item, 'unpublish'));
          if (item.published && item.draft)
            button('수정 초안 취소', () => queueAction(item, 'discard-draft'));
        }
        article.append(copy, actions);
        container.append(article);
      }
      if (list.length > 20) {
        const pagination = text('div', '', 'pagination');
        for (const [label, next] of [
          ['이전', page - 1],
          ['다음', page + 1]
        ]) {
          const b = text('button', label, 'secondary');
          b.disabled = next < 0 || next >= Math.ceil(list.length / 20);
          b.onclick = () => {
            pageNumbers[id] = next;
            render();
          };
          pagination.append(b);
        }
        pagination.append(text('span', page + 1 + ' / ' + Math.ceil(list.length / 20)));
        container.append(pagination);
      }
    }
    $('#new-entry').disabled = $('#new-draft-entry').disabled = !projects.length;
    resumeBanner();
  }
  function queueAction(item, action, historyId = null) {
    pendingAction = { item, action, historyId, requestId: crypto.randomUUID() };
    $('#action-title').textContent = {
      trash: '휴지통으로 이동할까요?',
      restore: '초안으로 복원할까요?',
      unpublish: '공개를 중지할까요?',
      'discard-draft': '수정 초안을 취소할까요?',
      history: '이 내용을 수정 초안으로 복원할까요?'
    }[action];
    $('#delete-message').textContent = '“' + titleOf(item) + '” 항목에 적용합니다.';
    $('#delete-error').hidden = true;
    $('#delete-dialog').showModal();
  }
  $('#cancel-delete').onclick = () => {
    if (!busy) $('#delete-dialog').close();
  };
  $('#delete-dialog').addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  $('#confirm-delete').onclick = async () => {
    if (busy) return;
    busy = true;
    $('#confirm-delete').disabled = true;
    try {
      replaceItem(
        await api.itemAction(
          pendingAction.item,
          pendingAction.action,
          pendingAction.requestId,
          pendingAction.historyId
        )
      );
      $('#delete-dialog').close();
      if ($('#history-dialog').open) $('#history-dialog').close();
      message('변경했습니다. 휴지통과 이력에서 이전 내용을 확인할 수 있습니다.');
    } catch (error) {
      $('#delete-error').textContent = errorText(error);
      $('#delete-error').hidden = false;
    } finally {
      busy = false;
      $('#confirm-delete').disabled = false;
    }
  };
  async function showHistory(item) {
    historyState = { item, offset: 0 };
    $('#history-list').replaceChildren();
    $('#history-dialog').showModal();
    await appendHistory();
  }
  async function appendHistory() {
    try {
      const rows = await api.history(historyState.item, historyState.offset);
      for (const row of rows) {
        const container = text('article', '', 'history-row');
        const previous = row.snapshot.draft || row.snapshot.published || {};
        container.append(
          text(
            'h3',
            '버전 ' +
              row.revision +
              ' · ' +
              new Date(row.saved_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
          ),
          text('p', previous.name || previous.title || ''),
          text('p', previous.description || previous.summary || '')
        );
        const restore = text('button', '이 버전을 수정 초안으로 복원', 'secondary');
        restore.onclick = () => queueAction(historyState.item, 'history', row.event_id);
        container.append(restore);
        $('#history-list').append(container);
      }
      historyState.offset += rows.length;
      $('#history-more').hidden = rows.length < 25;
      if (!historyState.offset) $('#history-list').textContent = '아직 이전 수정 이력이 없습니다.';
    } catch (error) {
      $('#history-list').append(text('p', errorText(error)));
    }
  }
  $('#history-more').onclick = appendHistory;
  $('#close-history').onclick = () => $('#history-dialog').close();
  $('#new-project').onclick = $('#new-draft-project').onclick = () => openEditor('project');
  $('#new-entry').onclick = $('#new-draft-entry').onclick = () => openEditor('entry');
  $('#new-idea').onclick = () => openEditor('idea');
  $('#entry-project-filter').onchange = () => {
    pageNumbers['entry-list'] = 0;
    render();
  };
  $('#open-drafts').onclick = () => {
    activateTab($('#manage-drafts'));
    $('#manage-drafts').focus();
  };
  $('#open-backup').onclick = () => activateTab($('#manage-backup'));
  $('#retry-migration').onclick = () => location.reload();
  function backupTime() {
    let stamp;
    try {
      stamp = localStorage.getItem('wanderer-backup:' + user?.id);
    } catch {}
    $('#backup-reminder').hidden = !!stamp && Date.now() - new Date(stamp).getTime() < 7 * 86400000;
    $('#backup-time').textContent = stamp
      ? '이 브라우저에서 마지막으로 내려받은 백업: ' + new Date(stamp).toLocaleString('ko-KR')
      : '아직 이 브라우저에서 내려받은 백업이 없습니다. 내용을 추가한 뒤 주기적으로 백업해 주세요.';
  }
  $('#export-backup').onclick = async () => {
    $('#export-backup').disabled = true;
    $('#backup-status').textContent = '전체 데이터와 첨부 이미지를 준비하는 중…';
    try {
      const backup = await api.exportBackup(
        (n, total) => ($('#backup-status').textContent = '이미지 백업 ' + n + ' / ' + total)
      );
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'wanderer-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      try {
        localStorage.setItem('wanderer-backup:' + user.id, new Date().toISOString());
      } catch {}
      backupTime();
      $('#backup-status').textContent =
        '백업 파일을 만들었습니다. 다운로드 폴더에서 확인해 주세요.';
    } catch (error) {
      $('#backup-status').textContent = errorText(error);
    } finally {
      $('#export-backup').disabled = false;
    }
  };
  $('#import-backup').onchange = (e) => {
    restoreFile = e.target.files[0];
    restoreId = crypto.randomUUID();
    $('#restore-backup').disabled = !restoreFile;
  };
  $('#restore-backup').onclick = async () => {
    if (!restoreFile || !confirm('기존 자료는 유지하고 백업 내용을 새 초안으로 추가할까요?'))
      return;
    $('#restore-backup').disabled = true;
    $('#backup-status').textContent = '이미지와 내용을 복원하는 중…';
    try {
      if (restoreFile.size > 100 * 1024 * 1024)
        throw Error('100MB 이하의 백업 파일을 선택해 주세요.');
      const result = await api.importBackup(JSON.parse(await restoreFile.text()), restoreId);
      items = await api.adminItems();
      render();
      $('#backup-status').textContent = result.restored + '개 항목을 새 초안으로 복원했습니다.';
      restoreFile = null;
      $('#import-backup').value = '';
    } catch (error) {
      $('#backup-status').textContent = errorText(error);
    } finally {
      $('#restore-backup').disabled = !restoreFile;
    }
  };
  function showLogin() {
    user = null;
    items = [];
    $('#dashboard').hidden = true;
    $('#migration-panel').hidden = true;
    $('#recovery-panel').hidden = true;
    $('#login-panel').hidden = false;
  }
  async function loadDashboard() {
    user = await api.verifyAdmin();
    if (!user) {
      showLogin();
      return;
    }
    $('#login-panel').hidden = true;
    if ((await api.version()) !== 2) {
      $('#migration-panel').hidden = false;
      message('확장 설정을 실행한 후 새로고침해 주세요. 기존 홈페이지는 계속 볼 수 있습니다.');
      return;
    }
    items = await api.adminItems();
    $('#migration-panel').hidden = true;
    $('#dashboard').hidden = false;
    $('#logout').hidden = false;
    $('#account-label').textContent = user.email + ' · 관리자';
    render();
    backupTime();
  }
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    message('로그인 확인 중…');
    try {
      await api.login($('#login-email').value.trim(), $('#login-password').value);
      $('#login-password').value = '';
      await loadDashboard();
      message('');
    } catch (error) {
      message(errorText(error), true);
      showLogin();
    } finally {
      button.disabled = false;
    }
  });
  $('#request-reset').addEventListener('click', async () => {
    const email = $('#login-email');
    if (!email.reportValidity()) {
      email.focus();
      return;
    }
    const button = $('#request-reset');
    button.disabled = true;
    message('재설정 이메일을 요청하고 있습니다…');
    try {
      await api.sendPasswordReset(email.value.trim());
      message(
        '등록된 계정이라면 재설정 이메일이 발송됩니다. 메일의 링크에서 새 비밀번호를 정해 주세요. 스팸함도 확인해 주세요.'
      );
    } catch (error) {
      message(errorText(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $('#recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('#new-password').value;
    if (password !== $('#confirm-password').value) {
      message('새 비밀번호와 확인 입력이 서로 다릅니다.', true);
      return;
    }
    if (!password.trim()) {
      message('공백으로만 된 비밀번호는 사용할 수 없습니다.', true);
      return;
    }
    const button = event.submitter;
    button.disabled = true;
    message('비밀번호를 변경하고 있습니다…');
    try {
      await api.updatePassword(password);
      $('#recovery-form').reset();
      $('#login-password').value = '';
      showLogin();
      message('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.');
    } catch (error) {
      message(errorText(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $('#logout').addEventListener('click', async () => {
    $('#logout').disabled = true;
    try {
      await api.logout();
      message('로그아웃했습니다.');
    } catch {
      message('이 브라우저에서 로그아웃했습니다. 서버 연결은 확인하지 못했습니다.', true);
    } finally {
      $('#logout').disabled = false;
      showLogin();
    }
  });
  // 이메일 링크를 이미 열린 관리자 탭으로 열어도 복구 화면을 초기화합니다.
  window.addEventListener('hashchange', () => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get('type') === 'recovery' || hash.has('error') || hash.has('error_code'))
      window.location.reload();
  });

  if (!api.configured || api.configurationError) {
    $('#setup-panel').hidden = false;
    message(api.configurationError || 'Supabase를 먼저 연결해 주세요.', true);
  } else {
    try {
      if (api.consumeRecoveryLink()) {
        api
          .verifyRecovery()
          .then(() => {
            $('#recovery-panel').hidden = false;
            $('#new-password').focus();
          })
          .catch((error) => {
            showLogin();
            message(errorText(error), true);
          });
      } else {
        message('계정을 확인하는 중…');
        loadDashboard()
          .then(() => {
            if (!$('#migration-panel').hidden) return;
            message('');
          })
          .catch((error) => {
            showLogin();
            message(errorText(error), true);
          });
      }
    } catch (error) {
      showLogin();
      message(errorText(error), true);
    }
  }
})();
