const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const electron = require('electron');
const { app, safeStorage, nativeImage, net } = electron;
const { Store } = require('./store.cjs');
const { readRecord, taskDirectory, createProgressWriter } = require('./local-executor.cjs');
const { Vault, Locations } = require('./locations.cjs');
const { Backend } = require('../backend.cjs');
const { ProxyRouter } = require('./proxy.cjs');
const { Agents } = require('./agents.cjs');
const { Skills } = require('./skills.cjs');

function launch(directory) {
  const workspace = path.dirname(path.dirname(directory));
  const id = path.basename(directory);
  if (taskDirectory(workspace, id) !== directory) throw new Error('Invalid local task directory.');
  const request = readRecord(directory, 'request.json');
  if (!request) { app.exit(1); return; }
  fs.unlinkSync(path.join(directory, 'request.json'));
  app.setPath('userData', path.join(workspace, 'executor-profile'));

  const chat = request.state.chats.find(item => item.id === request.chatId);
  const existingMessages = chat.messages.length;
  let sequence = 0, finished = false, result, failure;
  const publish = createProgressWriter(directory);
  const save = () => publish({
    sequence: ++sequence, at: Date.now(), pid:process.pid, finished, result, failure,
    messages: chat.messages.slice(existingMessages), binding: chat.nativeSessions?.[request.role.id],
  });
  const store = Object.assign(Object.create(Store.prototype), {directory:workspace, state:request.state, save});
  const controller = new AbortController();
  if (fs.existsSync(path.join(directory, 'cancel.json'))) controller.abort();
  const monitor = setInterval(() => {
    if (fs.existsSync(path.join(directory, 'cancel.json'))) controller.abort();
    save();
  }, 1000);
  save();
  app.whenReady().then(async () => {
    const vault = new Vault(workspace, safeStorage);
    const backend = new Backend(path.resolve(__dirname, '../..'), { shareControlMode:true });
    const locations = new Locations(store, vault, backend, async () => false, () => {});
    const network = new ProxyRouter(store, electron);
    const fetch = (input, options) => net.fetch(input, options);
    const agents = new Agents(store, vault, locations, save, {fetch, network});
    const skills = new Skills({store, vault, network, nativeImage, locations, fetch, emit:save});
    agents.skills = skills;
    skills.begin(id);
    try {
      const message = await agents.run(chat.id, request.role, request.project, controller.signal, false,
        {relayReplies:chat.relayReplies !== false, taskId:id});
      result = { status:message.status, stopConfirmed:message.stopConfirmed };
      if (controller.signal.aborted && !result.stopConfirmed) {
        save();
        // Keep ownership visible while the workbench tries to reclaim the process tree.
        await delay(20000);
      }
    } finally {
      skills.close();
      locations.close();
      backend.stop();
    }
  }).catch(error => { failure = error.message; }).finally(async () => {
    clearInterval(monitor);
    clearTimeout(store.saveTimer);
    finished = true;
    let saved = save();
    for (const waitMs of [100, 500, 1500]) {
      if (saved) break;
      await delay(waitMs);
      saved = save();
    }
    app.exit(saved && !failure ? 0 : 1);
  });
}

module.exports = { launch };
