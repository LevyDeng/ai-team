const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function until(js, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await js(expression)) return;
    await delay(50);
  }
  throw new Error('Workspace GUI fixture timed out: ' + expression);
}

async function run({ window, store, app, fixture, js, errors, services }) {
  store.sortProjects('name', 'asc');
  store.sortProjects('recent');
  const project = store.saveProject({ name: 'A Workspace Fixture', directories: fixture.project.directories });
  const { id: roleId, name: roleName } = fixture.roles[0];
  const chat = store.createChat({ projectId: project.id, roleIds: [roleId] }, {
    messages: Array.from({ length: 101 }, (_, index) => ({
      id: 'history-' + index, kind: 'assistant', roleId, roleName, locationId: 'local',
      text: index === 2 ? 'Find the earliest fixture' : 'History fixture ' + index,
      at: Date.now() + index, status: 'complete',
      ...(index === 2 ? { terminal: 'Hidden fixture log', activities: [{ title: 'Hidden fixture tool', status: 'complete' }] } : {}),
    })),
  });
  const nearby = store.createChat({ projectId: project.id, name: 'Nearby fixture', roleIds: [roleId] }, {
    updatedAt: 1,
    messages: [{ id: 'nearby-match', kind: 'user', text: 'Find the earliest fixture', at: 1 }],
  });
  const distant = store.createChat({ projectId: fixture.project.id, name: 'Distant fixture', roleIds: [roleId] }, {
    messages: Array.from({ length: 45 }, (_, index) => ({
      id: 'distant-' + index, kind: 'user',
      text: index === 1 ? 'Find the earliest fixture from another project' : 'Other fixture ' + index,
      at: index,
    })),
  });
  await js(`(async()=>{state=await api.snapshot();renderSidebar();$('project-select').value=${JSON.stringify(project.id)};$('project-select').dispatchEvent(new Event('change'));})()`);
  await until(js, "$('msg-history-100') && $('messages').children.length === 40");
  await until(js, `$('project-select').options[0].value === ${JSON.stringify(project.id)}`);
  assert.equal(await js("document.querySelector('label[for=project-order]').textContent"), '\u9879\u76ee\u6392\u5e8f');
  const localizedLabels = await js(`({
    searchButton: $('chat-find').getAttribute('aria-label'),
    searchTooltip: $('chat-find').title,
    searchPanel: $('chat-search').getAttribute('aria-label'),
    searchField: $('chat-search-input').getAttribute('aria-label'),
    searchPlaceholder: $('chat-search-input').placeholder,
    otherResults: $('other-chats-search').getAttribute('aria-label'),
    historyNavigation: $('history-pages').getAttribute('aria-label'),
    ...Object.fromEntries(['chat-search-close', 'chat-search-prev', 'chat-search-next', 'other-chats-search-toggle',
      'other-chats-search-prev', 'other-chats-search-next', 'history-older', 'history-newer', 'history-latest'].map(id => [id, $(id).textContent])),
  })`);
  for (const [control, label] of Object.entries(localizedLabels)) {
    assert.match(label, /\p{Script=Han}/u, control);
    assert.doesNotMatch(label, /[?\ufffd]/u, control);
  }
  assert.equal(await js("Boolean($('msg-history-2'))"), false);
  await js("$('history-older').click()");
  await until(js, "$('msg-history-60') && !$('msg-history-100')");
  await js(`$('chat-find').click();$('chat-search-input').value='earliest fixture';$('chat-search-input').dispatchEvent(new Event('input'));`);
  await until(js, "$('chat-search-results').children.length === 1");
  await js("$('chat-search-results').firstElementChild.click()");
  await until(js, "$('msg-history-2')?.classList.contains('message-search-match')");
  assert.equal(await js("$('msg-history-2').textContent.includes('Hidden fixture tool')"), false);
  await js("$('msg-history-2').querySelector('.message-tools').open=true");
  await until(js, "$('msg-history-2').textContent.includes('Hidden fixture tool')");
  assert.equal(await js("$('other-chats-search-toggle').hidden"), false);
  assert.equal(await js("$('other-chats-search').hidden && !$('other-chats-search-results').children.length"), true);
  await js("$('other-chats-search-toggle').click()");
  await until(js, "$('other-chats-search-results').children.length === 2");
  assert.equal(await js("$('chat-search-results').children.length"), 1);
  assert.deepEqual(await js("Array.from($('other-chats-search-results').querySelectorAll('small'), item => item.textContent)"), [
    project.name + ' / ' + nearby.name, fixture.project.name + ' / ' + distant.name,
  ]);
  await js("$('other-chats-search-toggle').click()");
  assert.equal(await js("$('other-chats-search').hidden"), true);
  await js("$('chat-search-input').value='another project';$('chat-search-input').dispatchEvent(new Event('input'));");
  await until(js, "!$('other-chats-search-toggle').hidden && !$('chat-search-results').children.length");
  await js("$('other-chats-search-toggle').click()");
  await until(js, "$('other-chats-search-results').children.length === 1");
  await js("$('input').value='Draft before search jump';$('other-chats-search-results').firstElementChild.click()");
  await until(js, "$('msg-distant-1')?.classList.contains('message-search-match')");
  assert.equal(await js("$('project-select').value"), fixture.project.id);
  assert.equal(await js("$('chat-title').textContent"), distant.name);
  assert.equal(await js("$('chat-search').hidden"), true);
  await js(`$('project-select').value=${JSON.stringify(project.id)};$('project-select').dispatchEvent(new Event('change'));`);
  await until(js, "$('msg-history-100') && $('input').value === 'Draft before search jump'");
  await js(`$('chat-find').click();$('chat-search-input').value='earliest fixture';$('chat-search-input').dispatchEvent(new Event('input'));`);
  await until(js, "$('chat-search-results').children.length === 1");
  await js("$('chat-search-results').firstElementChild.click()");
  await until(js, "$('msg-history-2')?.classList.contains('message-search-match')");
  await js("$('msg-history-2').querySelector('.task-output').click()");
  await until(js, "activityView?.output.includes('Hidden fixture log')");

  const reply = store.message(chat.id, { kind: 'assistant', roleId, roleName, text: 'Streaming fixture', status: 'running' });
  services.agents.emit({ chatId: chat.id, message: reply });
  await delay(150);
  assert.equal(await js(`Boolean($('msg-${reply.id}'))`), false);
  await js("$('history-latest').click()");
  await until(js, `$('msg-${reply.id}')?.textContent.includes('Streaming fixture')`);
  reply.text = 'Updated stream fixture';
  services.agents.emit({ chatId: chat.id, message: reply });
  await until(js, `$('msg-${reply.id}')?.textContent.includes('Updated stream fixture')`);
  await js("$('project-order').value='name';$('project-order').dispatchEvent(new Event('change'))");
  await until(js, "state.settings.projectOrder === 'name'");
  const projectOptions = "Array.from($('project-select').options, option => option.value)";
  const byName = [project, fixture.project].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map(item => item.id);
  assert.deepEqual(await js(projectOptions), byName);
  await js("$('project-order-direction').click()");
  await until(js, "state.settings.projectOrderDirections?.name === 'desc'");
  assert.deepEqual(await js(projectOptions), byName.toReversed());
  await js("$('project-order-direction').click()");
  await until(js, "state.settings.projectOrderDirections?.name === 'asc'");
  assert.deepEqual(await js(projectOptions), byName);
  await js("$('project-order-direction').click()");
  await until(js, "state.settings.projectOrderDirections?.name === 'desc'");

  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await until(js, `$('project-select')?.value === ${JSON.stringify(project.id)} && $('project-order').value === 'name' && $('messages').children.length === 40`);
  assert.deepEqual(await js(projectOptions), byName.toReversed());
  assert.deepEqual(errors, []);
  console.log('Workspace migration UI smoke passed.');
  app.exit(0);
}

module.exports = { run };
