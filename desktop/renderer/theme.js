// Loaded before styles so the last selected appearance is available on the first paint.
// settings.theme in planner-data.json is authoritative; this local cache only avoids a flash.
(function (root) {
  'use strict';

  const CACHE_KEY = 'planner-theme';
  const normalize = (value) => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  let mode = 'system';
  let resolved = 'light';
  let media = null;
  try {
    if (typeof root.matchMedia === 'function') media = root.matchMedia('(prefers-color-scheme: dark)');
  } catch { /* A missing media service falls back to light in system mode. */ }

  function render() {
    resolved = mode === 'system' ? (media && media.matches ? 'dark' : 'light') : mode;
    const html = root.document && root.document.documentElement;
    if (html) {
      html.setAttribute('data-theme', mode);
      html.setAttribute('data-resolved-theme', resolved);
    }
  }

  function apply(value) {
    mode = normalize(value);
    render();
    try { root.localStorage.setItem(CACHE_KEY, mode); }
    catch { /* Cache failure must not interrupt the app or its file storage. */ }
    return mode;
  }

  let cached;
  try { cached = root.localStorage.getItem(CACHE_KEY); }
  catch { /* Storage may be blocked or unavailable in a browser preview. */ }
  apply(cached);

  if (media) {
    if (typeof media.addEventListener === 'function') media.addEventListener('change', render);
    else if (typeof media.addListener === 'function') media.addListener(render);
  }

  root.PlannerTheme = Object.freeze({
    apply,
    normalize,
    getMode: () => mode,
    getResolved: () => resolved
  });
})(typeof window !== 'undefined' ? window : globalThis);
