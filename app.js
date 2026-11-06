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
    card.innerHTML = calendarArt + '<div class="card-body"><div class="card-meta"><span class="category"></span><span class="status"></span></div><h3></h3><p class="description"></p><div class="tags"></div><div class="card-action"></div></div>';
    card.querySelector('.category').textContent = project.category;
    card.querySelector('h3').textContent = project.name;
    card.querySelector('.description').textContent = project.description;
    card.querySelector('.status').textContent = project.status === 'live' ? '● 사용 가능' : '● 개발 중';
    for (const tag of project.tags) {
      const el = document.createElement('span'); el.textContent = tag; card.querySelector('.tags').append(el);
    }
    const link = document.createElement(project.url ? 'a' : 'button');
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
    card.querySelector('.card-action').append(link); grid.append(card);
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
