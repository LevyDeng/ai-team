/* Apply the cached preference before paint; the workspace remains authoritative. */
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('relay-desk-theme') || 'system'; } catch {}
  function apply(value) {
    preference = ['light', 'dark', 'system'].includes(value) ? value : 'system';
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    try { localStorage.setItem('relay-desk-theme', preference); } catch {}
  }
  media.addEventListener('change', () => apply(preference));
  window.applyDeskTheme = apply;
  apply(preference);
})();
