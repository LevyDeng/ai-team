const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const test = require('node:test');
const { Store } = require('../workbench/store.cjs');
const { readMessageDetail } = require('../workbench/workspace-db.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-team-workspace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('legacy import preserves cold details, reconciles a submitted queue entry, and restores from backup', async t => {
  const directory = temporary(t);
  const seed = new Store(temporary(t), directory);
  const { projects: [project], roles: [role] } = seed.state;
  const chat = seed.createChat({ projectId: project.id, roleIds: [role.id] });
  const user = seed.message(chat.id, { kind: 'user', text: 'Accepted request', status: 'accepted', inputQueueId: 'sent' });
  const reply = seed.message(chat.id, { kind: 'assistant', status: 'running', text: 'Partial reply', localTaskId: 'task',
    terminal: 'Fixture CLI output\n', activities: [{ title: 'Fixture tool', status: 'running' }] });
  chat.localTask = { id: 'task', roleId: role.id };
  chat.nativeSessions = { [role.id]: { status: 'submitting', id: 'native-session', seen: { [user.id]: 'receipt' } } };
  chat.inputQueue = [{ id: 'sent', value: { text: user.text } }, { id: 'pending', value: { text: 'Next request' } }];
  const legacy = path.join(directory, 'workspace.json');
  const original = JSON.stringify(seed.state);
  fs.writeFileSync(legacy, original);

  const store = new Store(directory, directory);
  const migrated = store.get('chats', chat.id);
  assert.deepEqual(migrated.messages.map(message => message.id), [user.id, reply.id]);
  assert.deepEqual(migrated.inputQueue.map(entry => entry.id), ['pending']);
  assert.equal(migrated.queuePaused, true);
  assert.equal(migrated.nativeSessions[role.id].status, 'uncertain');
  assert.equal(migrated.messages[1].status, 'running');
  const page = store.messagePage(chat.id).messages;
  assert.equal(page[1].activityCount, 1);
  assert.equal(Object.hasOwn(page[1], 'terminal'), false);
  assert.equal(Object.hasOwn(page[1], 'activities'), false);
  assert.equal(Object.hasOwn(store.summary().chats[0], 'messages'), false);
  assert.deepEqual(readMessageDetail(migrated.messages[1], 'activities'), reply.activities);
  migrated.messages[1].status = 'complete';
  store.save();
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);

  const restored = temporary(t);
  const db = new DatabaseSync(store.file);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    await backup(db, path.join(restored, 'workspace.sqlite'));
  } finally { db.close(); }
  const loaded = new Store(restored, directory);
  const stored = loaded.get('chats', chat.id);
  assert.equal(stored.messages[1].terminal, reply.terminal);
  assert.deepEqual(stored.messages[1].activities, reply.activities);
  assert.equal(stored.messages[1].status, 'complete');
  assert.equal(stored.localTask.id, 'task');
  assert.equal(stored.nativeSessions[role.id].seen[user.id], 'receipt');
});

test('draft writes remain isolated and a failed transaction can be retried', t => {
  const directory = temporary(t);
  const store = new Store(directory, directory);
  const { projects: [project], roles: [role] } = store.state;
  const chat = store.createChat({ projectId: project.id, roleIds: [role.id] });
  const message = store.message(chat.id, { kind: 'assistant', text: 'Old', terminal: 'Old log' });
  message.text = 'New';
  message.terminal = 'New log';
  store.saveDraft(chat, 'Saved draft');
  assert.equal(store.persisted().chats[0].draft, 'Saved draft');
  assert.equal(store.persisted().chats[0].messages[0].text, 'Old');
  const db = new DatabaseSync(store.file);
  try {
    db.exec("CREATE TRIGGER test_fail BEFORE UPDATE ON message_details BEGIN SELECT RAISE(ABORT, 'Fixture write failure'); END");
    assert.throws(() => store.save(), /Fixture write failure/);
    assert.equal(store.persisted().chats[0].messages[0].terminal, 'Old log');
    assert.equal(store.persisted().chats[0].messages[0].text, 'Old');
    db.exec('DROP TRIGGER test_fail');
  } finally { db.close(); }
  store.save();
  assert.equal(store.persisted().chats[0].messages[0].terminal, 'New log');
  assert.equal(store.persisted().chats[0].messages[0].text, 'New');
});

test('project preferences survive reopening and search jumps across message pages', t => {
  const directory = temporary(t);
  const store = new Store(directory, directory);
  const project = store.saveProject({ name: 'Another project', directories: [{ locationId: 'local', path: directory }] });
  store.selectProject(project.id);
  store.sortProjects('name', 'desc');
  store.sortProjects('created', 'asc');
  store.sortProjects('manual');
  store.sortProjects('created');
  assert.throws(() => store.sortProjects('manual', 'asc'), /排序方向/);
  const chat = store.createChat({ projectId: project.id, roleIds: [store.state.roles[0].id] }, {
    messages: Array.from({ length: 105 }, (_, index) => ({ id: 'm' + index, at: index, kind: 'user',
      text: index === 3 ? 'Find this Older text' : 'Ordinary message ' + index })),
  });
  const loaded = new Store(directory, directory);
  assert.equal(loaded.state.settings.lastProjectId, project.id);
  assert.equal(loaded.state.settings.projectOrder, 'created');
  assert.deepEqual(loaded.state.settings.projectOrderDirections, { name: 'desc', created: 'asc' });
  assert.ok(loaded.get('projects', project.id).createdAt);
  assert.ok(loaded.get('projects', project.id).lastUsedAt);
  const latest = loaded.messagePage(chat.id);
  assert.equal(latest.messages.length, 40);
  assert.equal(latest.messages[0].id, 'm65');
  const earlier = loaded.messagePage(chat.id, { before: latest.messages[0].id });
  assert.equal(earlier.messages.at(-1).id, 'm64');
  assert.ok(earlier.newer);
  assert.deepEqual(loaded.searchProject(project.id, 'older'), [chat.id]);
  const { matches } = loaded.searchMessages(chat.id, 'OLDER');
  assert.deepEqual(matches.map(match => match.id), ['m3']);
  const found = loaded.messagePage(chat.id, { around: matches[0].id });
  assert.equal(found.messages[3].id, 'm3');
  assert.equal(found.older, false);
});

test('searching other chats paginates across projects and excludes the current chat and workflow instructions', t => {
  const directory = temporary(t);
  const store = new Store(directory, directory);
  const { projects: [project], roles: [role] } = store.state;
  const otherProject = store.saveProject({ name: 'Other project', directories: project.directories });
  const createChat = (projectId, messages, updatedAt) =>
    store.createChat({ projectId, roleIds: [role.id] }, { messages, updatedAt });
  const match = id => ({ id, kind: 'user', text: 'Literal [needle] match' });
  const current = createChat(project.id, [match('current')], 1);
  const nearby = createChat(project.id, Array.from({ length: 31 }, (_, index) => match('nearby-' + index)), 2);
  const distant = createChat(otherProject.id, [match('distant'), { ...match('hidden'), workflowInstruction: true }], 3);
  const loaded = new Store(directory, directory);

  const first = loaded.searchOtherChats(current.id, ' [NEEDLE] ');
  assert.equal(first.total, 32);
  assert.equal(first.matches.length, 30);
  assert.equal(first.matches[0].id, 'nearby-30');
  assert.ok(first.matches.every(item => item.chatId === nearby.id && item.projectId === project.id));
  const second = loaded.searchOtherChats(current.id, '[needle]', 30);
  assert.deepEqual(second.matches.map(({ id, chatId, projectId }) => [id, chatId, projectId]), [
    ['nearby-0', nearby.id, project.id],
    ['distant', distant.id, otherProject.id],
  ]);
  assert.deepEqual(loaded.searchOtherChats(current.id, ' '), { matches: [], total: 0 });
});
