const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const invitations = require('./agent-invitations.cjs');
const {buildPrompt} = require('./agents.cjs');

async function waitFor(test, diagnostic = () => '') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await test()) return;
    await delay(40);
  }
  assert.fail('Timed out waiting for collaboration state. ' + await diagnostic());
}

async function run({window, store, app, directory, services, fixture, js, errors}) {
  const [sender, first, second] = fixture.roles;
  const id = fixture.chat.id;
  async function capture(name) {
    const rect = await js(`(() => {
      const {x,y,width,height} = $('dialog').getBoundingClientRect();
      return {x:Math.floor(x), y:Math.floor(y), width:Math.ceil(width), height:Math.ceil(height)};
    })()`);
    fs.writeFileSync(path.join(directory,name), (await window.webContents.capturePage(rect)).toPNG());
  }
  await js(`(async()=>{
    await api['role-save']({...role(${JSON.stringify(sender.id)}),defaultDuty:'Plan browser checks.'});
    await api.settings({...state.settings,aiInvites:{allowed:false,limit:3}});
    state=await api.snapshot(); openProject(project());
    $('p-tab-roles').click();
    document.querySelector('#p-role-duty .duty-source button').click();
    const field=document.querySelector('#p-role-duty textarea');
    field.value='Reproduce browser issues and capture evidence.'; field.dispatchEvent(new Event('input'));
    $('p-tab-collaboration').click();
    const allow=$('p-ai-invites').querySelector('[data-invite-enabled]'); allow.value='true'; allow.dispatchEvent(new Event('change'));
    $('dialog-form').requestSubmit();
  })()`);
  await waitFor(() => store.state.projects[0].aiInvites?.allowed);
  assert.equal(store.state.projects[0].roleDuties[sender.id], 'Reproduce browser issues and capture evidence.');
  await waitFor(() => js(`!$('dialog').open`));
  await js(`openProject(project()); $('p-tab-roles').click();`);
  assert.match(await js(`$('p-role-list').textContent`), /Reproduce browser issues/);
  await capture('project-roles-preview.png');
  await js(`$('p-tab-collaboration').click()`);
  assert.match(await js(`$('p-ai-invites').innerText`), /本层设置.*3 次（继承自全局）/);
  await capture('project-collaboration-preview.png');
  await js(`$('dialog').close();`);
  await delay(40);
  await js(`openChatRole(${JSON.stringify(sender.id)});`);
  assert.match(await js(`$('c-role-duty').innerText`), /继承自项目/);
  await js(`(() => {
    $('c-role-duty').querySelector('.duty-source button').click();
    $('c-role-duty').querySelector('textarea').value='Only check the checkout flow.';
    $('dialog-form').requestSubmit();
  })()`);
  await waitFor(() => fixture.chat.roleDuties?.[sender.id] === 'Only check the checkout flow.', () => js(`$('toast').textContent`));
  await waitFor(() => js(`!$('dialog').open`));
  await js(`openChat(chat());
    $('c-ai-invites').querySelector('[data-invite-limit]').value='1';
    $('dialog-form').requestSubmit();`);
  await waitFor(() => fixture.chat.aiInvites?.limit === 1);
  assert.equal(fixture.chat.aiInvites.allowed, undefined);

  const calls = [];
  services.agents.run = async (chatId, role, project, signal, summary, context) => {
    calls.push({role, context});
    const control = context.invitationOffer;
    const reply = `Normal reply with @${first.name} as plain text.`;
    const requests = [{roleId:first.id, task:'Check the checkout result.'}, {roleId:second.id, task:'Second request.'}];
    const frame = control ? `${control.open}${JSON.stringify(requests)}${control.close}` : '';
    if (control) {
      const prompt = buildPrompt(role, project, {...fixture.chat, ...context}, summary);
      assert.match(prompt, /Only check the checkout flow/);
      assert(prompt.includes(control.open));
      assert.equal(invitations.project(`${reply}\n${frame.slice(0, -4)}`, control, false).text, reply);
      assert.equal(invitations.project(`${reply}\n${frame} trailing prose`, control, true).invites, undefined);
      assert.equal(invitations.project(`${reply}\n${frame}`, invitations.offer(control.targets, 1), true).invites, undefined);
    }
    const parsed = invitations.project(frame ? `${reply}\n${frame}` : reply, control, true);
    const message = store.message(chatId, {kind:'assistant', roleId:role.id, roleName:role.name, text:parsed.text, status:'complete'});
    services.agents.emit({chatId,message});
    return {...message, invitationRequests: parsed.invites || (context.invitationTask ? requests : [])};
  };
  async function send(text, roleIds = [sender.id]) {
    await js(`api.send({chatId:${JSON.stringify(id)},roleIds:${JSON.stringify(roleIds)},text:${JSON.stringify(text)}})`);
    await waitFor(() => fixture.chat.messages.some(message => message.kind === 'user' && message.text === text) && !services.running.has(id));
  }
  await send('Check the checkout flow.');
  assert.deepEqual(calls.map(call => call.role.id), [sender.id, first.id]);
  assert.equal(calls[1].context.invitationOffer, undefined);
  assert.equal(calls[1].context.invitationTask.task, 'Check the checkout result.');
  assert.equal(fixture.chat.messages.filter(message => message.agentInvitation).length, 1);
  await waitFor(() => js(`Boolean(document.querySelector('.agent-invitation'))`));
  await send('Discuss the checkout flow.', [sender.id, second.id]);
  assert.deepEqual(calls.slice(2).map(call => call.role.id), [sender.id, first.id, second.id]);
  assert.equal(calls.at(-1).context.invitationOffer, undefined);

  await js(`(async()=>{
    await api['chat-save']({...chat(),aiInvites:{allowed:false}});
    state=await api.snapshot(); openChatRole(${JSON.stringify(sender.id)});
    $('c-role-duty').querySelector('.duty-source button').click();
    $('dialog-form').requestSubmit();
  })()`);
  await waitFor(() => fixture.chat.roleDuties?.[sender.id] === undefined);
  await send('Check without inviting anyone.');
  assert.equal(calls.length, 6);
  assert.equal(calls.at(-1).role.id, sender.id);
  assert.equal(calls.at(-1).context.teamAssignments.own, 'Reproduce browser issues and capture evidence.');
  const persisted = store.persisted();
  assert.equal(persisted.projects[0].aiInvites.allowed, true);
  assert.equal(persisted.chats.find(chat=>chat.id===id).aiInvites.allowed, false);
  assert.deepEqual(errors, []);
  console.log('Collaboration settings and invitation smoke checks passed.');
  app.exit(0);
}

module.exports = {run};
