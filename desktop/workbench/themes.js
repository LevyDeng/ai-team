((root) => {
  const themes = [
    { id: 'system', label: '跟随系统', description: '随 Windows 浅色 / 深色自动切换', tone: 'system', background: '#ffffff', swatches: ['#ffffff', '#f4f5f7', '#17a74e'] },
    { id: 'light', label: '浅色', description: '清爽明亮的默认浅色界面', tone: 'light', background: '#ffffff', swatches: ['#ffffff', '#f4f5f7', '#17a74e'] },
    { id: 'eyecare', label: '护眼绿（豆沙柔光）', description: '经典柔绿豆沙底色，减轻白屏刺眼', tone: 'light', background: '#e7f0e6', swatches: ['#e7f0e6', '#dce8dc', '#1f824c'] },
    { id: 'warm-paper', label: '暖纸米（羊皮护眼）', description: '暖米纸张质感，降低蓝光与反差疲劳', tone: 'light', background: '#f3ede1', swatches: ['#f3ede1', '#e8e0d1', '#2c7a4b'] },
    { id: 'mist-blue', label: '雾霭蓝（柔灰浅蓝）', description: '柔和冷灰蓝，长时间阅读清爽专注', tone: 'light', background: '#ecf1f5', swatches: ['#ecf1f5', '#e0e9f0', '#25738c'] },
    { id: 'dark', label: '深色（夜间模式）', description: '标准深灰夜间界面', tone: 'dark', background: '#191d23', swatches: ['#191d23', '#272f39', '#15803d'] },
    { id: 'forest-night', label: '静谧暗绿（护眼夜）', description: '低反差暗绿夜色，文字柔和不刺眼', tone: 'dark', background: '#161d1a', swatches: ['#161d1a', '#222c27', '#2b8252'] },
    { id: 'warm-night', label: '柔暖夜色（低蓝光）', description: '暖棕暗底配象牙字色，适合深夜久看', tone: 'dark', background: '#1d1a17', swatches: ['#1d1a17', '#2b2621', '#3b8255'] },
  ];
  const byId = new Map(themes.map(item => [item.id, item]));
  const isValid = value => byId.has(value);
  const normalize = value => isValid(value) ? value : 'system';
  function themeSource(value) {
    const entry = byId.get(normalize(value));
    return entry.tone === 'system' ? 'system' : entry.tone;
  }
  function resolve(value, prefersDark = false) {
    const preference = normalize(value);
    const theme = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
    const entry = byId.get(theme);
    return { preference, theme, tone: entry.tone, themeSource: themeSource(preference), background: entry.background };
  }
  const api = { themes, isValid, normalize, themeSource, resolve };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.deskThemes = api;
})(typeof globalThis === 'object' ? globalThis : this);
