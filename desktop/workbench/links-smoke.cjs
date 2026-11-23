const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,fixture,js,errors}){
  const opened=[],copies=[],revealed=[];services.shell.openPath=async file=>{opened.push(file);return '';};services.clipboard.writeText=text=>copies.push(text);services.shell.showItemInFolder=file=>revealed.push(file);
  async function until(expression){
    for(let attempt=0;attempt<75;attempt++){if(await js(expression))return;await wait(50);}
    throw new Error('Timed out waiting for link fixture: '+expression);
  }
  const folder=path.join(directory,'link fixture');fs.mkdirSync(folder,{recursive:true});const html=path.join(folder,'index.html'),notes=path.join(folder,'README.md');fs.writeFileSync(html,'<!doctype html><title>Acceptance fixture</title>');fs.writeFileSync(notes,'# Implementation fixture\n');
  const href=file=>'/'+file.replaceAll('\\','/').replaceAll(' ','%20');
  const markdown='[Open \u9a8c\u6536]('+href(html)+') · [Implementation]('+href(notes)+')';
  const message=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:markdown,terminal:'\x1b[32m'+markdown+'\x1b[0m\r\nCOPY_FIXTURE_PLAIN\r\n',status:'complete'});
  await js(`(async()=>{state=await api.snapshot();activateChat();Terminal.prototype.fixtureOriginal=Terminal.prototype.registerLinkProvider;Terminal.prototype.registerLinkProvider=function(provider){this.fixtureProviders||=[];this.fixtureProviders.push(provider);return this.fixtureOriginal(provider);};})()`);
  assert.equal(await js(`document.querySelectorAll('#msg-${message.id} .project-path-link').length`),2);
  await js(`document.querySelectorAll('#msg-${message.id} .project-path-link')[0].click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(html));
  await js(`document.querySelectorAll('#msg-${message.id} .project-path-link')[1].click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(notes));
  await js(`activityMode='log';activityRoleId=${JSON.stringify(fixture.roles[0].id)};activityRunId=${JSON.stringify(message.id)};activityFollow=false;openTools('activity')`);await wait(180);
  await js('new Promise(resolve=>activityView.term.write("",resolve))');
  const terminalLinks=await js(`(()=>{const term=activityView.term,result=new Map();for(let row=1;row<=term.buffer.active.length;row++)term.fixtureProviders[0].provideLinks(row,links=>{for(const link of links)result.set(link.text,{text:link.text,start:link.range.start,end:link.range.end});});return [...result.values()];})()`);
  assert.equal(terminalLinks.length,2);assert(terminalLinks.some(link=>link.end.y>link.start.y),'Actual terminal links must survive soft wrapping.');
  await js(`(()=>{const term=activityView.term;for(let row=1;row<=term.buffer.active.length;row++){let done=false;term.fixtureProviders[0].provideLinks(row,links=>{const link=links.find(l=>l.text.endsWith('index.html'));if(link){link.activate({preventDefault(){}});done=true;}});if(done)break;}})()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(html));
  await js('activityView.term.selectAll();activityView.term.focus();activityView.term.textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"c",code:"KeyC",keyCode:67,ctrlKey:true,bubbles:true,cancelable:true}))');await wait(100);assert(copies.at(-1).includes('Open \u9a8c\u6536'));assert(!copies.at(-1).includes('\x1b['));
  await js(`(()=>{const element=document.querySelector('#activity-host .terminal-container');element.dispatchEvent(new MouseEvent('mousedown',{button:2,bubbles:true,cancelable:true}));element.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));})()`);await wait(80);assert(copies.at(-1).includes('COPY_FIXTURE_PLAIN'));
  await js(`activityView.term.select(0,0,4);document.querySelector('#activity-copy').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));activityView.term.clearSelection();document.querySelector('#activity-copy').click()`);await wait(80);assert.equal(copies.at(-1),'[Ope');
  await js('activityView.term.clearSelection();document.querySelector("#activity-copy").click()');await wait(80);assert(copies.at(-1).includes('COPY_FIXTURE_PLAIN'));assert(!copies.at(-1).includes('\x1b['));
  const interactive=await js(`(()=>{const element=document.createElement('div');document.body.append(element);const term=new Terminal({cols:30,rows:4});term.open(element);const data=[];term.onData(value=>data.push(value));window.relayTerminalUI.installCopy(term,element,{copy:value=>api.copy(value)});term.write('Interactive fixture');window.fixtureCopyTerm={term,element,data};return true;})()`);assert(interactive);await wait(80);
  await js('fixtureCopyTerm.term.selectAll();fixtureCopyTerm.term.textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"c",code:"KeyC",keyCode:67,ctrlKey:true,bubbles:true,cancelable:true}))');await wait(80);assert.equal(await js('fixtureCopyTerm.data.length'),0);
  await js('fixtureCopyTerm.term.clearSelection();fixtureCopyTerm.term.textarea.dispatchEvent(new KeyboardEvent("keydown",{key:"c",code:"KeyC",keyCode:67,ctrlKey:true,bubbles:true,cancelable:true}))');
  assert.equal(await js('fixtureCopyTerm.data.some(value=>value.charCodeAt(0)===3)'),true);await js('fixtureCopyTerm.term.dispose();fixtureCopyTerm.element.remove()');
  const missing=path.join(folder,'missing image.png');
  const unsupported='![Unavailable](custom://host/output.png)';
  const source='Read '+html+' and "'+notes+'". Relative docs/review.md:18:2 and README.md.\n\n[Literal Windows](<'+notes+'>)\n\n'+unsupported+'\n\n[NAS](file://server/share/review.md)\n\n[Unsafe](javascript:alert(1))\n\n![Missing](<'+href(missing)+'>)\n\n```text\n'+notes+'\n```';
  const fallback=store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,roleName:fixture.roles[0].name,locationId:'local',text:source,status:'complete',contextTransfer:{mode:'paged',historyBytes:241166,inlineBytes:13960,messageCount:112}});
  await js('(async()=>{state=await api.snapshot();activateChat();})()');
  const selector='#msg-'+fallback.id;
  for(let n=0;n<80;n++){if(await js(`Boolean(document.querySelector(${JSON.stringify(selector+' .message-image-original-path')}))`))break;await wait(80);}
  const shown=await js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector+' .message-note')}).hidden`),false);assert((await js(`document.querySelector(${JSON.stringify(selector+' .message-note')}).textContent`)).includes('112'));
  assert(shown.includes(unsupported));assert(shown.includes('[NAS](file://server/share/review.md)'));assert(shown.includes(href(missing)));assert(shown.includes(missing));
  assert(shown.includes('[Unsafe](javascript:alert(1))'));assert.equal(await js(`document.querySelectorAll(${JSON.stringify(selector+' a[href^="javascript:"]')}).length`),0);
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(selector+' .message-bubble pre .project-path-link')}).length`),1);
  assert.equal(await js(`Array.from(document.querySelectorAll(${JSON.stringify(selector+' .message-bubble a')})).some(a=>a.getAttribute('href')?.startsWith('custom:'))`),false);
  fs.writeFileSync(path.join(directory,'path-links-dom.json'),JSON.stringify(await js(`({text:document.querySelector(${JSON.stringify(selector+' .message-bubble')}).textContent,links:Array.from(document.querySelectorAll(${JSON.stringify(selector+' .message-bubble a')})).map(a=>({text:a.textContent,title:a.title}))})`),null,2));
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(selector+' .message-bubble .project-path-link')})).find(a=>a.textContent===${JSON.stringify(html)}).click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(html));
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(selector+' .message-bubble .project-path-link')})).find(a=>a.textContent==='Literal Windows').click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(notes));
  await js(`document.querySelector(${JSON.stringify(selector+' .copy-full')}).click()`);await wait(80);assert.equal(copies.at(-1),source);assert.equal(store.get('chats',fixture.chat.id).messages.find(m=>m.id===fallback.id).text,source);
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'end'})`);await wait(100);fs.writeFileSync(path.join(directory,'path-fallback.png'),(await window.webContents.capturePage()).toPNG());
  const roots = ['alpha location','beta location'].map(name=>path.join(directory,name));
  for(const root of roots){
    fs.mkdirSync(path.join(root,'nested'),{recursive:true});
    fs.writeFileSync(path.join(root,'nested','collision.txt'),'Fixture');
  }
  const fromBeta = path.join(roots[1],'second-root.txt');
  const duplicate = path.join(roots[1],'nested','collision.txt');
  fs.writeFileSync(fromBeta,'Fixture');
  const remote = {id:'link-remote',name:'Remote Fixture',type:'ssh',os:'linux',control:'ssh'};
  store.state.locations.push(remote);
  fixture.project.directories = [
    ...roots.map(root=>({locationId:'local',path:root})),
    {locationId:remote.id,path:'/srv/fixture'},
  ];
  const contextual = store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,locationId:'local',
    text:'Read `./second-root.txt` and `collision.txt`.',status:'complete',
    activities:[{title:'Files: '+duplicate,status:'complete',paths:[duplicate]}]});
  const ambiguous = store.message(fixture.chat.id,{kind:'assistant',roleId:fixture.roles[0].id,locationId:'local',
    text:'Read `collision.txt` or `/srv/fixture/missing.txt`.',status:'complete'});
  await js('(async()=>{state=await api.snapshot();activateChat();})()');
  await until(`Boolean($('msg-${ambiguous.id}'))`);
  const link = (id,index) => `$('msg-${id}').querySelectorAll('.project-path-link')[${index}]`;
  await js(`${link(contextual.id,0)}.click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(fromBeta));
  await js(`${link(contextual.id,1)}.click()`);await wait(100);assert.equal(opened.at(-1),fs.realpathSync(duplicate));
  const count = opened.length;
  await js(`${link(ambiguous.id,0)}.click()`);
  await until("$('path-reference-results')?.querySelectorAll('input').length === 2");
  assert.equal(opened.length,count);
  assert.equal(await js("$('dialog-submit').disabled"),true);
  await js("const filterPath=$('path-reference-filter');filterPath.value='beta location';filterPath.dispatchEvent(new Event('input'));$('path-reference-results').querySelector('input').click();$('path-reference-copy').click()");
  await wait(80);assert.equal(copies.at(-1),fs.realpathSync(duplicate));
  await js("$('dialog-form').requestSubmit()");
  await until("!$('dialog').open");assert.equal(opened.at(-1),fs.realpathSync(duplicate));
  await js(`${link(contextual.id,0)}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
  await until("$('dialog').open && document.querySelector('.path-reference-name')?.textContent.includes('second-root.txt') && Boolean($('path-reference-reveal'))");
  await js("$('path-reference-reveal').click()");await wait(100);assert.equal(revealed.at(-1),fs.realpathSync(fromBeta));
  await js("$('dialog-close').click()");
  await js(`${link(ambiguous.id,1)}.click()`);
  await until("Boolean($('path-reference-remote'))");
  await js("$('dialog-close').click()");
  await wait(100);fs.writeFileSync(path.join(directory,'links-terminal.png'),(await window.webContents.capturePage()).toPNG());assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(directory,'links-checks.json'),JSON.stringify({passed:true,at:Date.now(),checks:['drive-prefixed Markdown clicks reach native openPath','encoded spaces resolve once','actual xterm soft-wrapped links','wide-character labels','Ctrl+C selection copy','right-click selection copy','copy button retains selection after focus changes','full output excludes ANSI codes','unselected interactive Ctrl+C still interrupts','plain quoted and code-block paths','unsupported image/link syntax remains visible','missing image path remains visible','full copy preserves original source'],consoleErrors:errors},null,2));app.exit(0);
}
module.exports={run};
