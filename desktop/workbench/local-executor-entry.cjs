const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app, safeStorage, nativeImage, net } = electron;
const { Store, atomic } = require('./store.cjs');
const { readRecord, taskDirectory } = require('./local-executor.cjs');
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
  const save = () => atomic(path.join(directory, 'progress.json'), {
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
    } finally {
      skills.close();
      locations.close();
      backend.stop();
    }
  }).catch(error => { failure = error.message; }).finally(() => {
    clearInterval(monitor);
    clearTimeout(store.saveTimer);
    finished = true;
    save();
    app.exit(failure ? 1 : 0);
  });
}

module.exports = { launch };
