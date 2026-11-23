const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function assertPinnedSave(js) {
  const position = await js(`(() => {
    const modal=$('dialog'), button=$('dialog-submit'), close=$('dialog-close');
    modal.style.maxHeight='400px';
    modal.scrollTop=0;
    const start=button.getBoundingClientRect();
    modal.scrollTop=modal.scrollHeight;
    const end=button.getBoundingClientRect();
    const result={
      scrolled:modal.scrollTop>0,
      pinned:Math.abs(start.top-end.top)<1 && Math.abs(start.left-end.left)<1,
      nextToClose:button.parentElement===close.parentElement && button.nextElementSibling===close,
      owner:button.form?.id,
      submitCount:modal.querySelectorAll('button[type=submit]').length,
    };
    modal.style.maxHeight='';
    modal.scrollTop=0;
    return result;
  })()`);
  assert.deepEqual(position,{scrolled:true,pinned:true,nextToClose:true,owner:'dialog-form',submitCount:1});
}
async function assertEditorSave(js, id) {
  const position = await js(`(() => {
    const form=$(${JSON.stringify(id)}), buttons=form.querySelectorAll('button[type=submit]');
    const button=buttons[0];
    form.style.height='280px';
    form.style.flex='none';
    form.scrollTop=0;
    const start=button.getBoundingClientRect();
    form.scrollTop=form.scrollHeight;
    const end=button.getBoundingClientRect();
    const result={
      scrolled:form.scrollTop>0,
      pinned:Math.abs(start.top-end.top)<1 && Math.abs(start.left-end.left)<1,
      header:button.parentElement===form.querySelector(':scope > header'),
      fits:button.getBoundingClientRect().right<=form.getBoundingClientRect().right,
      submitCount:buttons.length,
    };
    form.style.height='';
    form.style.flex='';
    form.scrollTop=0;
    return result;
  })()`);
  assert.deepEqual(position,{scrolled:true,pinned:true,header:true,fits:true,submitCount:1},id);
}
async function run({window,store,app,directory,services,js,errors}){
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
  await assertPinnedSave(js);
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
  window.focus();
  window.webContents.focus();
  await js(`openChat(chat());$('c-name').value='Saved with Enter';$('c-name').focus();`);
  assert.equal(await js(`document.activeElement.id`),'c-name');
  assert.equal(await js(`$('dialog-submit').disabled`),false);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  window.webContents.sendInputEvent({type:'char',keyCode:'Enter'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  for(let i=0;i<40 && await js(`$('dialog').open`);i++) await wait(25);
  assert.equal(await js(`$('dialog').open`),false);
  assert.equal(store.get('chats',id).name,'Saved with Enter');
  const [uninvited,...invited]=store.state.roles;
  store.get('projects',first).roleIds=invited.map(role=>role.id);store.save();
  await js('(async()=>{state=await api.snapshot();openChat();})()');
  assert.equal(await js(`$('dialog-submit').parentElement.className`),'dialog-actions');
  assert.deepEqual(await js(`[...document.querySelectorAll('.role-option input')].map(input=>input.value)`),[...invited.map(role=>role.id),uninvited.id]);
  await js(`(()=>{const search=document.querySelector('.role-picker-search input');search.value=${JSON.stringify(uninvited.name)};search.dispatchEvent(new Event('input'));document.querySelector('.role-option:not([hidden]) input').click();})()`);
  assert.equal(await js(`document.querySelector('.role-option:not([hidden]) input:checked')?.value`),uninvited.id);
  await js('document.querySelector("#dialog-close").click()');
  const archiveDir=path.join(directory,'archive');
  const workFile=path.join(directory,'project-work-fixture.txt');
  fs.writeFileSync(workFile,'Keep this file');
  const archives=()=>fs.existsSync(archiveDir)?fs.readdirSync(archiveDir).filter(name=>name.startsWith(other.id+'-')):[];
  await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(other.id)};renderSidebar();$('project-edit').click();})()`);
  await assertPinnedSave(js);
  await js(`$('p-name').value='Renamed project fixture';$('dialog-submit').click();`);
  for(let i=0;i<40 && await js(`$('dialog').open`);i++) await wait(25);
  assert.equal(await js(`$('dialog').open`),false);
  assert.equal(store.get('projects',other.id).name,'Renamed project fixture');
  await js(`$('project-edit').click()`);
  assert.match(await js(`$('project-delete').textContent`),/删除项目并归档/);
  assert.equal(await js(`$('dialog-body').lastElementChild.contains($('project-delete'))`),true);
  assert.match(await js(`$('project-delete-warning').textContent`),/磁盘文件会保留/);
  assert.equal(await js(`getComputedStyle($('project-delete')).backgroundColor`),'rgb(180, 35, 50)');
  services.dialog.showMessageBox=async ({buttons,detail})=>{
    assert.deepEqual(buttons,['取消','删除项目并归档']);
    assert.match(detail,/工作目录和文件将保留/);
    return {response:0};
  };
  await js(`$('project-delete').onclick()`);
  assert.equal(await js(`$('dialog').open`),true);
  assert.equal(store.get('chats',otherChat.id),otherChat);
  assert.deepEqual(archives(),[]);
  let lateChat;
  services.dialog.showMessageBox=async ()=>{
    lateChat=store.createChat({projectId:other.id,roleIds:otherChat.roleIds,name:'Created during confirmation'});
    return {response:1};
  };
  await js(`$('project-delete').onclick()`);
  assert.equal(await js(`$('dialog').open`),false);
  assert.equal(await js(`[...$('project-select').options].some(option=>option.value===${JSON.stringify(other.id)})`),false);
  assert.equal(fs.readFileSync(workFile,'utf8'),'Keep this file');
  assert.equal(archives().length,1);
  const archive=JSON.parse(fs.readFileSync(path.join(archiveDir,archives()[0]),'utf8'));
  assert.equal(archive.project.id,other.id);
  assert.deepEqual(new Set(archive.chats.map(chat=>chat.id)),new Set([otherChat.id,lateChat.id]));
  await js(`showPage('roles');editRole(state.roles[0]);`);
  await assertEditorSave(js,'role-form');
  assert.equal(await js(`$('role-delete').closest('.destructive-settings')!==null`),true);
  await js(`showPage('locations');editLocation(state.locations.find(location=>location.id==='local'));`);
  await assertEditorSave(js,'location-form');
  await js(`showPage('settings')`);
  await assertEditorSave(js,'settings-form');
  await js(`(async()=>{showPage('skills');await editSkill();})()`);
  await assertEditorSave(js,'skill-editor');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'dialog-close-checks.json'),JSON.stringify({passed:true,checks:['single chat settings entry','participant selection retained','shared top-right close button','close discards unsaved form','project and role and order and usage dialogs','close remains accessible when scrolled','save still works'],consoleErrors:errors},null,2));app.exit(0);
}
module.exports={run};
