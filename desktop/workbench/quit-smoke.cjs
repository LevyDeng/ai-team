const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { configure } = require('./workflow.cjs');

async function run({window, store, app, services, fixture, js, mode}) {
  const active = mode === 'active' || mode === 'timeout';
  const restart = mode === 'restart';
  const chat = fixture.chat;
  const role = fixture.roles[0];
  const draft = 'Draft typed immediately before closing';
  const confirmations = [];
  let answer, stopRequested = false, stopFinished = false, queuedWorkflow, relaunched = false, restartBlocked = false;
  if (restart) app.relaunch = () => { relaunched = true; };
  services.dialog.showMessageBox = (_parent, options) => {
    if (options.type === 'info') { restartBlocked = true; return Promise.resolve({response:0}); }
    return new Promise(resolve => {
      confirmations.push(options);
      answer = response => resolve({response});
    });
  };
  const fromFooter = command => js(`$('workbench-menu').click();$('workbench-${command}').click();`);
  const until = async check => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await delay(25);
    }
    assert.fail('Expected workbench state was not reached.');
  };

  if (active) {
    store.state.settings.maxJobs = 1;
    services.agents.run = async (chatId, profile, _project, signal) => {
      const message = store.message(chatId, {kind:'assistant', roleId:profile.id, roleName:profile.name, text:'Partial reply', status:'running'});
      await new Promise(resolve => signal.addEventListener('abort', () => { stopRequested = true; resolve(); }, {once:true}));
      if (mode === 'timeout') return new Promise(() => {});
      await delay(150);
      message.status = 'cancelled';
      stopFinished = true;
      return message;
    };
    const recipient = JSON.stringify([role.id]);
    await js(`api.send({chatId,text:'Start a fixture task',roleIds:${recipient}})`);
    await until(() => services.running.has(chat.id));
    await js(`api.send({chatId,text:'Keep this queued message',roleIds:${recipient}})`);
    const workflow = configure({goal:'Keep this workflow paused',criteria:'No unapproved restart',limit:1,
      teams:{implement:[role.id],review:[role.id]}}, fixture.roles);
    queuedWorkflow = store.createChat({projectId:fixture.project.id, name:workflow.goal, roleIds:[role.id]}, {workflow});

    await fromFooter('restart');
    await until(() => restartBlocked);
    assert.equal(stopRequested, false);
    window.close();
    app.quit();
    await until(() => confirmations.length > 0);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].cancelId, 0);
    answer(0);
    await delay(50);
    assert.equal(window.isDestroyed(), false);
    assert.equal(stopRequested, false);
    assert.equal(chat.inputQueue[0].value.text, 'Keep this queued message');
    assert.equal(queuedWorkflow.workflow.status, 'queued');
  }

  const quitDeadline = setTimeout(() => {
    console.error('Workbench did not quit within the smoke-test deadline.');
    app.exit(1);
  }, 12000);
  app.once('will-quit', () => {
    clearTimeout(quitDeadline);
    try {
      assert.equal(confirmations.length, active ? 2 : 0);
      assert.equal(relaunched, restart);
      assert.equal(stopRequested, active);
      assert.equal(stopFinished, mode === 'active');
      const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
      const savedChat = saved.chats.find(item => item.id === chat.id);
      assert.equal(savedChat.draft, draft);
      if (active) {
        assert.equal(savedChat.inputQueue[0].value.text, 'Keep this queued message');
        assert.equal(savedChat.queuePaused, true);
        assert.equal(saved.chats.find(item => item.id === queuedWorkflow.id).workflow.status, 'paused');
      }
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });

  await js(`$('input').value=${JSON.stringify(draft)};$('input').dispatchEvent(new Event('input'));`);
  if (active) {
    await fromFooter('quit');
    await until(() => confirmations.length === 2);
    answer(1);
  } else if (restart) {
    assert.deepEqual(await js(`$('workbench-menu').click();const first=document.activeElement.id;document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));[first,$('workbench-menu-panel').hidden,document.activeElement.id]`),['awake-toggle',true,'workbench-menu']);
    const { supportUrl } = require('../package.json');
    assert.match(supportUrl, /^https:\/\/github\.com\/.+#support-the-project$/);
    const openExternal = services.shell.openExternal;
    let opened;
    try {
      services.shell.openExternal = async url => { opened = url; };
      await fromFooter('support');
      await until(() => Boolean(opened));
      assert.equal(opened, supportUrl);
    } finally {
      services.shell.openExternal = openExternal;
    }
    await js(`$('workbench-menu').click();$('awake-toggle').click();`);
    await until(() => !store.state.settings.keepAwake);
    assert.equal(await js(`$('awake-toggle').getAttribute('aria-pressed')`),'false');
    await js(`$('input').focus();`);
    await fromFooter('restart');
  } else {
    window.close();
  }
}

module.exports = { run };
