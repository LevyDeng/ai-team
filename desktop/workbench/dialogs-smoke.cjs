const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,js,errors}){
  const other=store.saveProject({name:'Unread Project Fixture',directories:[{locationId:'local',path:directory}]});
  const otherChat=store.createChat({projectId:other.id,roleIds:[store.state.roles[0].id]});otherChat.unread=true;store.save();
  await js('(async()=>{state=await api.snapshot();renderSidebar();})()');
  assert.equal(await js('document.querySelector("#project-unread").hidden'),false);
  assert((await js('document.querySelector("#project-select").title')).includes(other.name));
  assert((await js(`document.querySelector('#project-select option[value="${other.id}"]').textContent`)).startsWith('● '));
  const first=await js('projectId');
  await js(`document.querySelector('#project-select').value=${JSON.stringify(other.id)};document.querySelector('#project-select').dispatchEvent(new Event('change'));`);
  assert.equal(await js('document.querySelector("#project-unread").hidden'),true);
  await js(`document.querySelector('#project-select').value=${JSON.stringify(first)};document.querySelector('#project-select').dispatchEvent(new Event('change'));`);
  assert.equal(await js('document.querySelector("#project-unread").hidden'),false);
  fs.writeFileSync(path.join(directory,'project-unread.png'),(await window.webContents.capturePage()).toPNG());
  otherChat.unread=false;store.save();await js('(async()=>{state=await api.snapshot();renderProjectNotifications();})()');assert.equal(await js('document.querySelector("#project-unread").hidden'),true);
  const id=await js('chat().id'),before=JSON.stringify(store.get('chats',id));
  assert.equal(await js('Boolean(document.querySelector("#invite"))'),false);
  assert.equal(await js('document.querySelector("#chat-settings").hidden'),false);
  await js('document.querySelector("#chat-settings").click()');await wait(100);
  assert.equal(await js('document.querySelector("#dialog").open'),true);assert.equal(await js('Boolean(document.querySelector("#chat-role-picker"))'),true);
  const title=await js('document.querySelector("#dialog-title").textContent');assert(title.includes('对话设置'));
  await js('document.querySelector("#c-name").value="Unsaved fixture name";');
  fs.writeFileSync(path.join(directory,'dialog-close-settings.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(await js('document.querySelector("#dialog-close").textContent.trim()'),'×');
  assert.equal(await js('getComputedStyle(document.querySelector("#dialog-close")).color===getComputedStyle(document.body).color'),true);
  await js('document.querySelector("#dialog-close").click()');await wait(50);assert.equal(await js('document.querySelector("#dialog").open'),false);assert.equal(JSON.stringify(store.get('chats',id)),before);
  for(const expression of ['openProject(project())','openChatRole(chat().roleIds[0])','openGroupOrder()','openUsage()']){
    await js(expression);await wait(80);assert.equal(await js('document.querySelector("#dialog").open'),true);
    assert.equal(await js('document.querySelectorAll("#dialog-close").length'),1);
    assert.equal(await js('document.querySelector("#dialog-close").getAttribute("type")'),'button');
    const placement=await js('(()=>{const d=document.querySelector("#dialog"),b=document.querySelector("#dialog-close").getBoundingClientRect(),r=d.getBoundingClientRect();return b.right<=r.right&&b.top>=r.top&&b.left>r.left+r.width/2;})()');assert(placement);
    await js('document.querySelector("#dialog").scrollTop=10000;');await wait(30);
    assert.equal(await js('(()=>{const b=document.querySelector("#dialog-close").getBoundingClientRect(),r=document.querySelector("#dialog").getBoundingClientRect();return b.bottom>r.top&&b.top<r.bottom;})()'),true);
    await js('document.querySelector("#dialog-close").click()');await wait(30);assert.equal(await js('document.querySelector("#dialog").open'),false);
  }
  await js('openChat(chat())');await js('document.querySelector("#dialog-form").requestSubmit()');await wait(150);assert.equal(await js('document.querySelector("#dialog").open'),false);
  const [uninvited,...invited]=store.state.roles;
  store.get('projects',first).roleIds=invited.map(role=>role.id);store.save();
  await js('(async()=>{state=await api.snapshot();openChat();})()');
  assert.deepEqual(await js(`[...document.querySelectorAll('.role-option input')].map(input=>input.value)`),[...invited.map(role=>role.id),uninvited.id]);
  await js(`(()=>{const search=document.querySelector('.role-picker-search input');search.value=${JSON.stringify(uninvited.name)};search.dispatchEvent(new Event('input'));document.querySelector('.role-option:not([hidden]) input').click();})()`);
  assert.equal(await js(`document.querySelector('.role-option:not([hidden]) input:checked')?.value`),uninvited.id);
  await js('document.querySelector("#dialog-close").click()');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'dialog-close-checks.json'),JSON.stringify({passed:true,checks:['single chat settings entry','participant selection retained','shared top-right close button','close discards unsaved form','project and role and order and usage dialogs','close remains accessible when scrolled','save still works'],consoleErrors:errors},null,2));app.exit(0);
}
module.exports={run};
