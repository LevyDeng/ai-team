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
  await js(`(async()=>{state=await api.snapshot();renderSidebar();$('project-select').value=${JSON.stringify(project.id)};$('project-select').dispatchEvent(new Event('change'));})()`);
  await until(js, "$('msg-history-100') && $('messages').children.length === 40");
  await until(js, `$('project-select').options[0].value === ${JSON.stringify(project.id)}`);
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
  assert.deepEqual(await js("Array.from($('project-select').options, option => option.value)"),
    [project, fixture.project].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map(item => item.id));

  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await until(js, `$('project-select')?.value === ${JSON.stringify(project.id)} && $('project-order').value === 'name' && $('messages').children.length === 40`);
  assert.deepEqual(errors, []);
  console.log('Workspace migration UI smoke passed.');
  app.exit(0);
}

module.exports = { run };
