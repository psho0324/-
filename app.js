const grid = document.querySelector('#project-grid');
const dialog = document.querySelector('#project-dialog');
const filters = [...document.querySelectorAll('[data-filter]')];
const projects = window.projects;
const calendarArt = `<div class="calendar-art" aria-hidden="true"><div class="art-top"><span>일상을 정리하는 작은 여유</span><span>↗</span></div><div class="calendar"><div class="calendar-head"><span>나의 한 주</span><span>‹ &nbsp; ›</span></div><div class="week"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span><span>일</span></div><div class="days"><span>12</span><span>13</span><span class="today">14</span><span>15</span><span>16</span><span>17</span><span>18</span></div><div class="schedule"><span class="event green">새로운 아이디어 정리</span><span class="event purple">나만의 집중 시간</span><span class="event orange">잠깐, 산책하기</span></div><div class="calendar-bottom">작은 계획으로 채우는, 더 좋은 하루 <span>✳</span></div></div><span class="art-caption">MAKE ROOM FOR YOUR DAY.</span></div>`;
function render(filter = 'all') {
  grid.replaceChildren();
  const visible = projects.filter(p => filter === 'all' || p.status === filter);
  document.querySelector('#empty').hidden = visible.length > 0;
  for (const project of visible) {
    const card = document.createElement('article');
    card.className = 'project-card';
    card.innerHTML = (project.id === 'calendar' ? calendarArt : '<div class="workspace-art" aria-hidden="true"><span>WANDERER’S WORKSPACE</span><strong>작은 시작을<br>모으는 곳.</strong><span>떠돌이의 작업실 ↗</span></div>') + '<div class="card-body"><div class="card-meta"><span class="category"></span><span class="status"></span></div><h3></h3><p class="description"></p><div class="tags"></div><div class="card-action"></div></div>';
    card.querySelector('.category').textContent = project.category;
    card.querySelector('h3').textContent = project.name;
    card.querySelector('.description').textContent = project.description;
    card.querySelector('.status').textContent = project.status === 'live' ? '● 사용 가능' : '● 개발 중';
    for (const tag of project.tags) {
      const el = document.createElement('span'); el.textContent = tag; card.querySelector('.tags').append(el);
    }
    const hasUrl = /^https?:\/\//.test(project.url || '');
    const link = document.createElement(hasUrl ? 'a' : 'button');
    if (project.url && /^https?:\/\//.test(project.url)) {
      link.href = project.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '앱 사용해 보기 ↗';
    } else {
      link.textContent = '프로젝트 이야기 ↗';
      link.addEventListener('click', () => {
        document.querySelector('#dialog-title').textContent = project.name;
        document.querySelector('#dialog-description').textContent = project.description;
        document.querySelector('#dialog-note').textContent = project.note;
        dialog.showModal();
      });
    }
    const journalButton = document.createElement('button');
    journalButton.type = 'button';
    journalButton.className = 'project-journal-link';
    journalButton.textContent = '제작 기록 ↗';
    journalButton.setAttribute('aria-label', project.name + ' 제작 기록');
    journalButton.addEventListener('click', () => {
      renderJournal(project.id);
      selectCategory(document.querySelector('#tab-journal'));
      document.querySelector('#tab-journal').focus();
      document.querySelector('#projects').scrollIntoView({ block: 'start' });
    });
    card.querySelector('.card-action').append(link, journalButton); grid.append(card);
  }
  for (const button of filters) {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', selected);
    button.querySelector('span').textContent = button.dataset.filter === 'all' ? projects.length : projects.filter(p => p.status === button.dataset.filter).length;
  }
  document.querySelector('#project-count').textContent = String(projects.length).padStart(2, '0');
}
filters.forEach(button => button.addEventListener('click', () => render(button.dataset.filter)));
document.querySelector('#reset-filter').addEventListener('click', () => render());
dialog.querySelector('.close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
render();

// 카테고리 탭: 클릭과 방향키로 이동하고 한 패널씩 표시합니다.
const categoryTabs = [...document.querySelectorAll('[role="tab"]')];
function selectCategory(tab) {
  for (const item of categoryTabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
}
categoryTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectCategory(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % categoryTabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + categoryTabs.length) % categoryTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = categoryTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectCategory(categoryTabs[next]);
    categoryTabs[next].focus();
  });
});


// 각 기록은 projectId로 프로젝트에 연결됩니다.
const journalFilterGroup = document.querySelector('#journal-filters');
const journalList = document.querySelector('#journal-list');
for (const item of [{ id: 'all', name: '전체' }, ...projects]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.journalFilter = item.id;
  button.textContent = item.name;
  const count = document.createElement('span');
  count.textContent = window.journalEntries.filter(entry => item.id === 'all' || entry.projectId === item.id).length;
  button.append(count);
  button.addEventListener('click', () => renderJournal(item.id));
  journalFilterGroup.append(button);
}
function renderJournal(projectId = 'all') {
  const entries = window.journalEntries
    .filter(entry => projectId === 'all' || entry.projectId === projectId)
    .slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  for (const button of journalFilterGroup.querySelectorAll('button')) {
    const selected = button.dataset.journalFilter === projectId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  journalList.replaceChildren();
  journalList.hidden = entries.length === 0;
  document.querySelector('#journal-empty').hidden = entries.length > 0;
  const name = projects.find(project => project.id === projectId)?.name || '전체 프로젝트';
  document.querySelector('#journal-empty-title').textContent = name + '의 첫 이야기를 기다리는 중';
  document.querySelector('#journal-result').textContent = name + ' · ' + entries.length + '개의 기록';
  for (const entry of entries) {
    const article = document.createElement('article');
    article.className = 'journal-entry';
    article.innerHTML = '<time class="journal-date"></time><div class="journal-content"><span class="entry-label"></span><h3></h3><p class="entry-summary"></p><details><summary>자세히 보기</summary><p class="entry-body"></p></details></div>';
    const time = article.querySelector('time');
    time.dateTime = entry.date;
    time.textContent = entry.date.replaceAll('-', '.');
    article.querySelector('.entry-label').textContent = projects.find(project => project.id === entry.projectId)?.name || '프로젝트';
    article.querySelector('h3').textContent = entry.title;
    article.querySelector('.entry-summary').textContent = entry.summary;
    article.querySelector('.entry-body').textContent = entry.body;
    journalList.append(article);
  }
}
renderJournal();
