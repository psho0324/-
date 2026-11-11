(() => {
  const $ = (s) => document.querySelector(s),
    api = window.WorkspaceBackend;
  const states = Object.fromEntries(
    ['project', 'entry', 'idea'].map((kind) => [
      kind,
      { items: [], total: 0, filter: null, generation: 0, loading: false }
    ])
  );
  let mode,
    modePromise,
    catalog = [],
    legacy = {},
    detailId,
    journalSelected = false,
    catalogLoading = false,
    detailRequest = 0;
  const categories = window.PROJECT_CATEGORIES;
  const calendarArt = `<div class="calendar-art" aria-hidden="true"><div class="art-top"><span>일상을 정리하는 작은 여유</span><span>↗</span></div><div class="calendar"><div class="calendar-head"><span>나의 한 주</span><span>‹ &nbsp; ›</span></div><div class="week"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span><span>일</span></div><div class="days"><span>12</span><span>13</span><span class="today">14</span><span>15</span><span>16</span><span>17</span><span>18</span></div><div class="schedule"><span class="event green">새로운 아이디어 정리</span><span class="event purple">나만의 집중 시간</span><span class="event orange">잠깐, 산책하기</span></div><div class="calendar-bottom">작은 계획으로 채우는, 더 좋은 하루 <span>✳</span></div></div><span class="art-caption">MAKE ROOM FOR YOUR DAY.</span></div>`;
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value || '';
    if (className) el.className = className;
    return el;
  };
  const label = (value) => categories.find((c) => c.value === value)?.label || value || '기타';
  // Older/imported records can predate strict server validation. Display defensively
  // without rewriting or deleting their source data.
  const stringList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  function validDate(value) {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000-')) return false;
    const timestamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }

  const tabs = [...document.querySelectorAll('[role=tab]')];
  function selectTab(tab) {
    if (tab.id === 'tab-journal') showJournalPicker();
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', selected);
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      let next =
        e.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : e.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? tabs.length - 1
                : null;
      if (next === null) return;
      e.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  document
    .querySelector('nav a[href="#projects"]')
    .addEventListener('click', () => selectTab($('#tab-projects')));
  const dialog = $('#project-dialog');
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    detailRequest++;
    const url = new URL(location.href);
    url.searchParams.delete('project');
    history.replaceState(null, '', url);
  });
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    )
      dialog.close();
  });
  async function getMode() {
    if (mode) return mode;
    if (!modePromise)
      modePromise = (
        api.configured && window.WORKSPACE_CONFIG.useDatabase ? api.version() : Promise.resolve(0)
      )
        .then((v) => (mode = v))
        .catch((e) => {
          modePromise = null;
          throw e;
        });
    return modePromise;
  }
  async function old(kind) {
    if (!legacy[kind])
      legacy[kind] = (
        api.configured
          ? api.legacyList(kind)
          : Promise.resolve(kind === 'project' ? window.projects : window.journalEntries)
      ).catch((e) => {
        delete legacy[kind];
        throw e;
      });
    return legacy[kind];
  }
  async function addImage(container, value, alt, isCurrent = () => true) {
    if (!value) return;
    const image = new Image();
    image.className = 'project-image';
    image.alt = alt;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    try {
      const source = await api.resolveImage(value);
      if (!isCurrent()) return;
      image.src = source;
      image.addEventListener('error', () => image.remove());
      container.append(image);
    } catch {
      /* Keep readable text when an image is unavailable. */
    }
  }
  async function showDetail(id) {
    const request = ++detailRequest;
    const isCurrent = () => request === detailRequest && dialog.open;
    detailId = id;
    $('#dialog-title').textContent = '프로젝트 소개';
    $('#dialog-description').textContent = '';
    $('#dialog-note').textContent = '';
    $('#dialog-images').replaceChildren();
    $('#detail-status').textContent = '소개를 불러오는 중…';
    $('#share-project').hidden = false;
    if (!dialog.open) dialog.showModal();
    const url = new URL(location.href);
    url.searchParams.set('project', id);
    history.replaceState(null, '', url);
    try {
      const data =
        (await getMode()) === 2
          ? (await api.publicDetail('project', id))?.data
          : (await old('project')).find((p) => p.id === id);
      if (!isCurrent()) return;
      if (!data) throw Error('이 프로젝트는 공개 중이 아니거나 존재하지 않습니다.');
      $('#dialog-title').textContent = data.name;
      $('#dialog-description').textContent = data.description;
      $('#dialog-note').textContent = data.note || '아직 상세 소개가 없습니다.';
      $('#detail-status').textContent = '';
      await addImage($('#dialog-images'), data.imageUrl, data.name + ' 대표 이미지', isCurrent);
    } catch (e) {
      if (!isCurrent()) return;
      $('#detail-status').textContent =
        e.message || '소개를 불러오지 못했습니다. 다시 열어 주세요.';
    }
  }
  $('#share-project').addEventListener('click', async () => {
    const url = new URL('projects/' + encodeURIComponent(detailId) + '/', location.href);
    try {
      await navigator.clipboard.writeText(url.href);
      $('#detail-status').textContent = '주소를 복사했습니다.';
    } catch {
      $('#detail-status').textContent = url.href;
    }
  });
  $('#detail-download').addEventListener('click', () => showDownload(detailId));
  const downloadDialog = $('#download-dialog');
  let downloadRequest = 0;
  $('#download-close').addEventListener('click', () => downloadDialog.close());
  downloadDialog.addEventListener('close', () => {
    downloadRequest++;
  });
  downloadDialog.addEventListener('click', (event) => {
    const r = downloadDialog.getBoundingClientRect();
    if (
      event.target === downloadDialog &&
      (event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom)
    )
      downloadDialog.close();
  });
  function safeDownloadUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }
  function officialWindowsInstaller(href) {
    return /^https:\/\/github\.com\/psho0324\/-\/releases\/(?:latest\/download|download\/v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)\/MyPlanner-Setup\.exe$/.test(
      href
    );
  }
  async function showDownload(id) {
    const request = ++downloadRequest;
    $('#download-title').textContent = '앱 다운로드';
    $('#download-description').textContent = '';
    $('#download-platforms').hidden = true;
    $('#download-status').textContent = '다운로드 안내를 불러오는 중…';
    const link = $('#download-pc-link');
    link.hidden = true;
    link.removeAttribute('href');
    $('#download-unsigned-notice').hidden = true;
    if (!downloadDialog.open) downloadDialog.showModal();
    try {
      let data =
        (await getMode()) === 2
          ? (await api.publicDetail('project', id))?.data
          : (await old('project')).find((project) => project.id === id);
      if (request !== downloadRequest) return;
      if (!data) throw Error('현재 공개된 다운로드 안내가 없습니다.');
      const release = window.WORKSPACE_CONFIG?.desktopReleases?.[id];
      // Keep CMS publication visibility and explicit download settings authoritative.
      // A released installer can supply defaults before its URL is entered in the CMS.
      if (!data.downloadUrl && release?.ready === true) data = { ...data, ...release };
      const href = safeDownloadUrl(data.downloadUrl),
        platform =
          { windows: 'Windows', macos: 'macOS', linux: 'Linux' }[data.downloadPlatform] || 'PC';
      $('#download-title').textContent = data.name + ' 다운로드';
      $('#download-description').textContent = data.description || '';
      $('#download-pc-title').textContent = platform + ' 버전';
      $('#download-version').hidden = !data.downloadVersion;
      $('#download-version').textContent = data.downloadVersion
        ? '버전 ' + data.downloadVersion
        : '';
      $('#download-requirements').textContent =
        data.downloadRequirements ||
        (href
          ? '설치 방법은 다운로드 파일 또는 배포 페이지의 안내를 확인해 주세요.'
          : '지원 환경과 설치 방법은 파일 공개 시 안내합니다.');
      $('#download-pc-badge').textContent = href ? '다운로드 가능' : '준비 중';
      $('#download-pc-badge').classList.toggle('available', !!href);
      $('#download-pc-pending').hidden = !!href;
      if (href) {
        link.href = href;
        link.textContent = platform + ' 버전 받기 ↗';
        link.hidden = false;
      }
      $('#download-unsigned-notice').hidden = !(
        id === 'calendar' &&
        data.downloadPlatform === 'windows' &&
        release?.unsigned !== false &&
        officialWindowsInstaller(href)
      );
      const mobilePlanned = data.mobilePlanned ?? id === 'calendar';
      $('#download-mobile-badge').textContent = mobilePlanned ? '지원 준비 중' : '미등록';
      $('#download-mobile-note').textContent = mobilePlanned
        ? '모바일에서도 사용할 수 있도록 준비하고 있어요.'
        : '아직 모바일 설치 파일이 등록되지 않았어요.';
      $('#download-status').textContent = '';
      $('#download-platforms').hidden = false;
    } catch (error) {
      if (request === downloadRequest)
        $('#download-status').textContent =
          error.message || '다운로드 안내를 불러오지 못했습니다. 창을 닫았다 다시 열어 주세요.';
    }
  }
  function renderProjects() {
    const grid = $('#project-grid');
    grid.replaceChildren();
    for (const project of states.project.items) {
      const card = document.createElement('article');
      card.className = 'project-card';
      const art =
        project.id === 'calendar'
          ? document.createElement('div')
          : text('div', '', 'workspace-art');
      if (project.id === 'calendar') {
        art.innerHTML = calendarArt;
      } else {
        art.append(
          text('span', label(project.category)),
          text('strong', project.name),
          text('span', 'BUILD · TRY · LEARN')
        );
      }
      card.append(art);
      if (project.imageUrl) {
        api
          .resolveImage(project.imageUrl)
          .then((src) => {
            const image = new Image();
            image.className = 'project-image';
            image.alt = project.name + ' 대표 이미지';
            image.loading = 'lazy';
            image.referrerPolicy = 'no-referrer';
            image.onload = () => {
              art.hidden = true;
            };
            image.onerror = () => image.remove();
            image.src = src;
            card.prepend(image);
          })
          .catch(() => {});
      }
      const body = document.createElement('div');
      body.className = 'card-body';
      const meta = text('div', '', 'card-meta');
      meta.append(
        text('span', label(project.category), 'category'),
        text('span', project.status === 'live' ? '● 사용 가능' : '● 개발 중', 'status')
      );
      body.append(meta);
      const heading = text('h3', project.name);
      body.append(heading, text('p', project.description, 'description'));
      const tags = text('div', '', 'tags');
      stringList(project.tags).forEach((tag) => tags.append(text('span', tag)));
      body.append(tags);
      const actions = text('div', '', 'card-action');
      const download = text('button', '다운로드 ↓');
      download.className = 'project-download';
      download.setAttribute('aria-label', project.name + ' 다운로드');
      download.addEventListener('click', () => showDownload(project.id));
      actions.append(download);
      const detail = text('button', '소개 보기');
      detail.addEventListener('click', () => showDetail(project.id));
      actions.append(detail);
      const journal = text('button', '제작 기록 ↗');
      journal.setAttribute('aria-label', project.name + ' 제작 기록');
      journal.addEventListener('click', () => {
        selectTab($('#tab-journal'));
        openJournal(project.id);
        $('#projects').scrollIntoView({ block: 'start' });
      });
      actions.append(journal);
      body.append(actions);
      card.append(body);
      grid.append(card);
    }
  }
  function renderJournalFilters() {
    const group = $('#journal-filters');
    group.replaceChildren();
    const projects = [
      ...catalog.filter((p) => p.showInProjects !== false),
      ...catalog.filter((p) => p.showInProjects === false)
    ];
    for (const item of [{ id: null, name: '전체' }, ...projects]) {
      const all = item.id === null;
      const button = text('button', '', 'journal-project-card');
      button.type = 'button';
      button.dataset.journalFilter = item.id === null ? '*' : 'project:' + item.id;
      button.setAttribute('aria-label', (all ? '전체' : item.name) + ' 제작 기록 보기');
      const top = text('span', '', 'journal-card-top');
      const icon = text('span', '', 'journal-card-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = all
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4V4Zm9 3a3 3 0 0 1 3-3h4v14h-3a4 4 0 0 0-4 3"/></svg>';
      const arrow = text('span', '↗', 'journal-card-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      top.append(icon, arrow);
      button.append(
        top,
        text('span', all ? 'ALL STORIES' : 'PROJECT JOURNAL', 'journal-card-label'),
        text('strong', item.name, 'journal-card-title'),
        text(
          'span',
          all ? '작업실에 쌓인 모든 이야기를 한곳에서.' : '시작부터 업데이트까지, 만드는 과정.',
          'journal-card-description'
        ),
        text('span', '제작 기록 보기 →', 'journal-card-link')
      );
      button.addEventListener('click', () => openJournal(item.id));
      group.append(button);
    }
  }
  function showJournalPicker(focusCard = false) {
    const state = states.entry;
    journalSelected = false;
    state.generation++;
    state.loading = false;
    state.items = [];
    state.total = 0;
    $('#journal-picker').hidden = false;
    $('#journal-records').hidden = true;
    $('#journal-list').replaceChildren();
    $('#entry-status').textContent = '';
    $('#entry-retry').hidden = true;
    $('#entry-more').hidden = true;
    $('#journal-empty').hidden = true;
    if (focusCard) {
      const filter = state.filter === null ? '*' : 'project:' + state.filter;
      [...$('#journal-filters').querySelectorAll('button')]
        .find((button) => button.dataset.journalFilter === filter)
        ?.focus();
    }
  }
  function openJournal(projectId) {
    journalSelected = true;
    states.entry.filter = projectId;
    $('#journal-picker').hidden = true;
    $('#journal-records').hidden = false;
    const name =
      projectId === null ? '전체' : catalog.find((p) => p.id === projectId)?.name || '프로젝트';
    $('#journal-title').textContent = name + ' 제작 기록';
    $('#journal-result').textContent = '';
    load('entry', true);
    $('#journal-title').focus();
  }
  $('#journal-back').addEventListener('click', () => showJournalPicker(true));
  function renderEntries() {
    const list = $('#journal-list');
    list.replaceChildren();
    for (const entry of states.entry.items) {
      const article = text('article', '', 'journal-entry');
      const hasDate = validDate(entry.date);
      const date = text('time', hasDate ? entry.date.replaceAll('-', '. ') : '날짜 확인 필요', 'journal-date');
      if (hasDate) date.dateTime = entry.date;
      const content = text('div', '', 'journal-content');
      content.append(
        text(
          'span',
          entry.projectName || catalog.find((p) => p.id === entry.projectId)?.name || '프로젝트',
          'entry-label'
        ),
        text('h3', entry.title),
        text('p', entry.summary, 'entry-summary')
      );
      const details = document.createElement('details');
      details.append(text('summary', '자세히 보기'));
      const body = text('div', '', 'entry-detail');
      details.append(body);
      let loaded = false;
      details.addEventListener('toggle', async () => {
        if (!details.open || loaded) return;
        body.textContent = '내용을 불러오는 중…';
        try {
          const data =
            (await getMode()) === 2 ? (await api.publicDetail('entry', entry.id))?.data : entry;
          if (!data) throw Error();
          body.replaceChildren(text('p', data.body, 'entry-body'));
          for (const image of stringList(data.images))
            await addImage(body, image, '제작 기록 첨부 이미지');
          loaded = true;
        } catch {
          body.textContent = '내용을 불러오지 못했습니다. 접었다 다시 열어 주세요.';
        }
      });
      content.append(details);
      article.append(date, content);
      list.append(article);
    }
  }
  function renderIdeas() {
    const list = $('#idea-list');
    list.replaceChildren();
    for (const idea of states.idea.items) {
      const card = text('article', '', 'idea-card');
      card.append(
        text(
          'span',
          { idea: '아이디어', exploring: '탐색 중', planned: '준비 중' }[idea.stage] || '아이디어',
          'status'
        ),
        text('h3', idea.title),
        text('p', idea.summary)
      );
      list.append(card);
    }
  }
  function updateCounts() {
    const projects = catalog.filter((p) => p.showInProjects !== false);
    document.querySelectorAll('[data-filter]').forEach((button) => {
      const value = button.dataset.filter;
      button.querySelector('span').textContent = (
        value === 'all' ? projects : projects.filter((p) => p.status === value)
      ).length;
    });
    $('#project-count').textContent = String(projects.length).padStart(2, '0');
  }
  async function load(kind, reset = false) {
    if (kind === 'entry' && !journalSelected) return;
    const state = states[kind];
    if (state.loading && !reset) return;
    const generation = ++state.generation;
    const filter = state.filter;
    if (reset) {
      state.items = [];
      ({ project: renderProjects, entry: renderEntries, idea: renderIdeas })[kind]();
    }
    state.loading = true;
    $('#' + kind + '-status').textContent = '불러오는 중…';
    $('#' + kind + '-retry').hidden = true;
    $('#' + kind + '-more').hidden = true;
    try {
      const currentMode = await getMode();
      if (generation !== state.generation) return;
      let page;
      if (currentMode === 2) {
        page = await api.publicList(kind, state.items.length, {
          projectId: kind === 'entry' ? filter : null,
          status: kind === 'project' ? filter : null
        });
        page.items = page.items.map((item) => ({ ...item.data, id: item.id }));
      } else if (kind === 'idea') page = { items: [], total: 0 };
      else {
        let data = await old(kind);
        if (kind === 'project')
          data = data.filter((p) => p.showInProjects !== false && (!filter || p.status === filter));
        else if (filter !== null) data = data.filter((e) => e.projectId === filter);
        page = {
          total: data.length,
          items: data.slice(state.items.length, state.items.length + 12)
        };
      }
      if (generation !== state.generation) return;
      state.items.push(...page.items);
      state.total = page.total;
      ({ project: renderProjects, entry: renderEntries, idea: renderIdeas })[kind]();
      $('#' + kind + '-status').textContent = '';
      $('#' + kind + '-more').hidden = state.items.length >= state.total;
      if (kind === 'project') $('#empty').hidden = state.total > 0;
      if (kind === 'entry') {
        const name = catalog.find((p) => p.id === state.filter)?.name || '전체 프로젝트';
        $('#journal-result').textContent = name + ' · ' + state.total + '개의 기록';
        $('#journal-empty').hidden = state.total > 0;
        $('#journal-empty-title').textContent = name + '의 첫 이야기를 기다리는 중';
      }
      if (kind === 'idea') $('#idea-empty').hidden = state.total > 0;
    } catch {
      if (generation !== state.generation) return;
      $('#' + kind + '-status').textContent =
        '불러오지 못했습니다. 아래 버튼으로 다시 시도해 주세요.';
      $('#' + kind + '-retry').hidden = false;
    } finally {
      if (generation === state.generation) state.loading = false;
    }
  }
  for (const kind of Object.keys(states)) {
    $('#' + kind + '-retry').addEventListener('click', () => load(kind));
    $('#' + kind + '-more').addEventListener('click', () => load(kind));
  }
  document.querySelectorAll('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      states.project.filter = button.dataset.filter === 'all' ? null : button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((other) => {
        other.classList.toggle('selected', other === button);
        other.setAttribute('aria-pressed', other === button);
      });
      load('project', true);
    })
  );
  $('#reset-filter').addEventListener('click', () =>
    document.querySelector('[data-filter=all]').click()
  );
  renderJournalFilters();
  ['project', 'idea'].forEach((kind) => load(kind, true));
  async function loadCatalog() {
    if (catalogLoading) return;
    catalogLoading = true;
    $('#journal-picker-status').textContent = '프로젝트를 불러오는 중…';
    $('#journal-picker-retry').hidden = true;
    try {
      catalog = (await getMode()) === 2 ? await api.catalog() : await old('project');
      updateCounts();
      renderJournalFilters();
      $('#journal-picker-status').textContent = '';
      if (journalSelected) {
        const name =
          states.entry.filter === null
            ? '전체'
            : catalog.find((p) => p.id === states.entry.filter)?.name || '프로젝트';
        $('#journal-title').textContent = name + ' 제작 기록';
        renderEntries();
      }
    } catch {
      $('#journal-picker-status').textContent = '프로젝트를 불러오지 못했어요. 다시 시도해 주세요.';
      $('#journal-picker-retry').hidden = false;
    } finally {
      catalogLoading = false;
    }
  }
  $('#journal-picker-retry').addEventListener('click', loadCatalog);
  loadCatalog();
  const shared = new URL(location.href).searchParams.get('project');
  if (shared) showDetail(shared);
})();
