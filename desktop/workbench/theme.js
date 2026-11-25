/* Apply the cached preference before paint; the workspace remains authoritative. */
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const themes = window.deskThemes;
  let preference = 'system';
  try { preference = localStorage.getItem('relay-desk-theme') || 'system'; } catch {}
  function apply(value) {
    const resolved = themes
      ? themes.resolve(value, media.matches)
      : (() => {
          const pref = ['light', 'dark', 'system'].includes(value) ? value : 'system';
          const theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
          return { preference: pref, theme, tone: theme === 'dark' ? 'dark' : 'light' };
        })();
    preference = resolved.preference;
    document.documentElement.dataset.theme = resolved.theme;
    document.documentElement.dataset.themeTone = resolved.tone;
    try { localStorage.setItem('relay-desk-theme', preference); } catch {}
  }
  media.addEventListener('change', () => apply(preference));
  window.applyDeskTheme = apply;
  apply(preference);
})();
