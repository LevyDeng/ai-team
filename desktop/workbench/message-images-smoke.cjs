const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,fixture,js,errors}){
  const until=async check=>{for(let n=0;n<100;n++){if(await check())return;await wait(80);}throw new Error('Message image GUI fixture timed out.');};
  const folder=path.join(directory,'image gallery fixture');fs.mkdirSync(folder,{recursive:true});
  const png=await js(`(()=>{const c=document.createElement('canvas');c.width=1200;c.height=450;const x=c.getContext('2d');for(let i=0;i<3;i++){x.fillStyle=['#214852','#25495e','#183c52'][i];x.fillRect(i*400,0,399,450);x.fillStyle='#b1f3ff';x.font='30px sans-serif';x.fillText(['A / Lattice','B / Space','C / Slash'][i],i*400+24,48);x.beginPath();x.moveTo(i*400+40,320);x.lineTo(i*400+350,130);x.lineTo(i*400+280,260);x.fill();}return c.toDataURL('image/png').split(',')[1];})()`);
  const output=path.join(folder,'panel #1.png'),copy=path.join(folder,'copy.png');fs.writeFileSync(output,Buffer.from(png,'base64'));fs.copyFileSync(output,copy);
  const message=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'Generated comparison. See the reference README for details.',status:'complete',activities:[{id:'copy',status:'complete',title:'Copy-Item source.png -Destination "'+output+'"'},{id:'files',status:'complete',title:'Files: '+copy}]});
  const opened=[],copied=[];const originalOpen=services.shell.openPath,originalCopy=services.clipboard.writeText;services.shell.openPath=async filename=>{opened.push(filename);return '';};services.clipboard.writeText=text=>copied.push(text);
  try{
    await js(`(async()=>{state=await api.snapshot();projectId=${JSON.stringify(fixture.project.id)};chatId=${JSON.stringify(fixture.chat.id)};activateChat();})()`);
    const selector='#msg-'+message.id+' .message-images';
    await until(async()=>await js(`Boolean(document.querySelector(${JSON.stringify(selector+' img')})?.naturalWidth)`));
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(selector+' img')}).length`),1);
    assert(!(JSON.stringify(store.get('chats',fixture.chat.id).messages.find(m=>m.id===message.id))).includes('base64'));
    await js(`document.querySelector(${JSON.stringify(selector+' .message-image-view')}).click()`);
    await until(()=>js("$('message-image-dialog').open && $('message-image-full').naturalWidth === 1200"));
    assert.equal(opened.length,0);
    await js("$('message-image-size').click()");
    assert.equal(await js("$('message-image-size').getAttribute('aria-pressed')"),'true');
    await js("$('message-image-open').click()");await until(()=>opened.length>0);assert.equal(opened.at(-1),fs.realpathSync(output));
    await js("$('message-image-close').click()");
    await js(`document.querySelector(${JSON.stringify(selector+' figcaption button:last-child')}).click()`);await until(async()=>copied.length>0);assert.equal(copied.at(-1),output);
    await js('activateChat()');await until(async()=>await js(`Boolean(document.querySelector(${JSON.stringify(selector+' img')})?.naturalWidth)`));
    await js(`document.querySelector(${JSON.stringify('#msg-'+message.id)}).scrollIntoView({block:'center'})`);await wait(100);fs.writeFileSync(path.join(directory,'message-images.png'),(await window.webContents.capturePage()).toPNG());
    const explicit=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'![Result](</'+output.replaceAll('\\','/')+'>)',status:'complete'});
    const remote=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:'![Remote](https://fixture.invalid/private-tracker.png)',status:'complete'});
    await js('(async()=>{state=await api.snapshot();activateChat();})()');await until(async()=>await js(`Boolean(document.querySelector('#msg-${explicit.id} .message-images img')?.naturalWidth)`));
    await wait(100);assert.equal(await js(`document.querySelectorAll('#msg-${remote.id} img[src*="fixture.invalid"]').length`),0);
    assert.equal(await js(`document.querySelectorAll('#msg-${remote.id} .message-images img').length`),0);
    const thumbnail=await js(`$('msg-${explicit.id}').querySelector('.message-images img').src`);
    fs.unlinkSync(output);
    await js(`$('msg-${explicit.id}').querySelector('.message-image-view').click()`);
    await until(()=>js("$('message-image-dialog').open && $('message-image-status').textContent.includes('\u7f29\u7565\u56fe')"));
    assert.equal(await js("$('message-image-full').src"),thumbnail);
    assert.equal(await js("$('message-image-open').disabled"),true);
    assert.equal(await js("$('dialog').open"),false);
    await js("$('message-image-close').click()");
    assert.equal(errors.length,0,errors.join('\n'));
    fs.writeFileSync(path.join(directory,'message-images-checks.json'),JSON.stringify({passed:true,at:Date.now(),checks:['historical copy-output recovery','native decoded thumbnail through IPC','duplicate image merged','no image bytes in saved history','in-app original-size preview','thumbnail fallback after the file is removed','open original','copy path','reopen history without regeneration','Markdown image path with spaces and hash','remote image is not fetched'],consoleErrors:errors},null,2));
  }finally{services.shell.openPath=originalOpen;services.clipboard.writeText=originalCopy;}
  app.exit(0);
}
module.exports={run};
