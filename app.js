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
    detailId;
  const categories = window.PROJECT_CATEGORIES;
  const calendarArt = `<div class="calendar-art" aria-hidden="true"><div class="art-top"><span>일상을 정리하는 작은 여유</span><span>↗</span></div><div class="calendar"><div class="calendar-head"><span>나의 한 주</span><span>‹ &nbsp; ›</span></div><div class="week"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span><span>일</span></div><div class="days"><span>12</span><span>13</span><span class="today">14</span><span>15</span><span>16</span><span>17</span><span>18</span></div><div class="schedule"><span class="event green">새로운 아이디어 정리</span><span class="event purple">나만의 집중 시간</span><span class="event orange">잠깐, 산책하기</span></div><div class="calendar-bottom">작은 계획으로 채우는, 더 좋은 하루 <span>✳</span></div></div><span class="art-caption">MAKE ROOM FOR YOUR DAY.</span></div>`;
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value || '';
    if (className) el.className = className;
    return el;
  };
  const label = (value) => categories.find((c) => c.value === value)?.label || value || '기타';
  const tabs = [...document.querySelectorAll('[role=tab]')];
  function selectTab(tab) {
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
  async function addImage(container, value, alt) {
    if (!value) return;
    const image = new Image();
    image.className = 'project-image';
    image.alt = alt;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    try {
      image.src = await api.resolveImage(value);
      image.addEventListener('error', () => image.remove());
      container.append(image);
    } catch {
      /* Keep readable text when an image is unavailable. */
    }
  }
  async function showDetail(id) {
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
      if (detailId !== id) return;
      if (!data) throw Error('이 프로젝트는 공개 중이 아니거나 존재하지 않습니다.');
      $('#dialog-title').textContent = data.name;
      $('#dialog-description').textContent = data.description;
      $('#dialog-note').textContent = data.note || '아직 상세 소개가 없습니다.';
      $('#detail-status').textContent = '';
      await addImage($('#dialog-images'), data.imageUrl, data.name + ' 대표 이미지');
    } catch (e) {
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
      (project.tags || []).forEach((tag) => tags.append(text('span', tag)));
      body.append(tags);
      const actions = text('div', '', 'card-action');
      if (/^https:\/\//.test(project.url || '')) {
        const a = text('a', '앱 열기 ↗');
        a.href = project.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        actions.append(a);
      }
      const detail = text('button', '소개 보기');
      detail.addEventListener('click', () => showDetail(project.id));
      actions.append(detail);
      const journal = text('button', '제작 기록 ↗');
      journal.setAttribute('aria-label', project.name + ' 제작 기록');
      journal.addEventListener('click', () => {
        states.entry.filter = project.id;
        renderJournalFilters();
        load('entry', true);
        selectTab($('#tab-journal'));
        $('#tab-journal').focus();
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
    for (const item of [{ id: null, name: '전체' }, ...catalog]) {
      const button = text('button', item.name);
      button.type = 'button';
      button.dataset.journalFilter = item.id === null ? '*' : 'project:' + item.id;
      const selected = states.entry.filter === item.id;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected);
      button.addEventListener('click', () => {
        states.entry.filter = item.id;
        renderJournalFilters();
        load('entry', true);
      });
      group.append(button);
    }
  }
  function renderEntries() {
    const list = $('#journal-list');
    list.replaceChildren();
    for (const entry of states.entry.items) {
      const article = text('article', '', 'journal-entry');
      const date = text('time', entry.date.replaceAll('-', '. '), 'journal-date');
      date.dateTime = entry.date;
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
          for (const image of data.images || [])
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
    const state = states[kind];
    if (state.loading && !reset) return;
    const generation = ++state.generation;
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
      let page;
      if (currentMode === 2) {
        page = await api.publicList(kind, state.items.length, {
          projectId: kind === 'entry' ? state.filter : null,
          status: kind === 'project' ? state.filter : null
        });
        page.items = page.items.map((item) => ({ ...item.data, id: item.id }));
      } else if (kind === 'idea') page = { items: [], total: 0 };
      else {
        let data = await old(kind);
        if (kind === 'project')
          data = data.filter(
            (p) => p.showInProjects !== false && (!state.filter || p.status === state.filter)
          );
        else if (state.filter !== null) data = data.filter((e) => e.projectId === state.filter);
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
  ['project', 'entry', 'idea'].forEach((kind) => load(kind, true));
  getMode()
    .then((v) => (v === 2 ? api.catalog() : old('project')))
    .then((data) => {
      catalog = data;
      updateCounts();
      renderJournalFilters();
      renderEntries();
    })
    .catch(() => {
      const retry = text('button', '프로젝트 필터 다시 불러오기', 'retry-button');
      retry.onclick = () => location.reload();
      $('#journal-filters').append(retry);
    });
  const shared = new URL(location.href).searchParams.get('project');
  if (shared) showDetail(shared);
})();
