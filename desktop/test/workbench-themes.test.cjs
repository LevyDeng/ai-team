const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const themes = require('../workbench/themes.js');
const { Store } = require('../workbench/store.cjs');

test('theme presets cover system, light eye-care, and low-glare dark themes with valid nativeTheme mappings', () => {
  const ids = themes.themes.map(item => item.id);
  for (const required of ['system', 'light', 'eyecare', 'warm-paper', 'mist-blue', 'dark', 'forest-night', 'warm-night']) {
    assert.ok(ids.includes(required), `missing theme ${required}`);
    assert.equal(themes.isValid(required), true);
  }
  assert.equal(themes.isValid('unknown-theme'), false);
  assert.equal(themes.normalize('unknown-theme'), 'system');

  const eyecare = themes.resolve('eyecare', true);
  assert.equal(eyecare.theme, 'eyecare');
  assert.equal(eyecare.tone, 'light');
  assert.equal(eyecare.themeSource, 'light');
  assert.equal(eyecare.background, '#e7f0e6');

  const forest = themes.resolve('forest-night', false);
  assert.equal(forest.theme, 'forest-night');
  assert.equal(forest.tone, 'dark');
  assert.equal(forest.themeSource, 'dark');
  assert.equal(forest.background, '#161d1a');

  assert.equal(themes.resolve('system', true).theme, 'dark');
  assert.equal(themes.resolve('system', false).theme, 'light');
});

test('Store preserves eye-care and soft themes and falls back on unknown values', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-themes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory, directory);
  for (const id of ['eyecare', 'warm-paper', 'mist-blue', 'forest-night', 'warm-night']) {
    store.state.settings.theme = id;
    store.save();
    const reloaded = new Store(directory, directory);
    assert.equal(reloaded.state.settings.theme, id);
  }
  store.state.settings.theme = 'bogus';
  store.save();
  const fallback = new Store(directory, directory);
  assert.equal(fallback.state.settings.theme, 'system');
});
