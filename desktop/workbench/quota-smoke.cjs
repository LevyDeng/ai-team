const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,services,js,errors}){
  if(process.argv.includes('--quota-live-only'))return live({window,store,app,directory,services,js,errors});
  store.saveRole({...store.state.roles[0],id:undefined,name:'Native Quota Route',engine:'antigravity',provider:'native',locationId:'local',executable:process.execPath,codexLoginSource:'isolated'});const processes=[],copied=[];
  const managed = {id:'quota-fixture',name:'Fixture VPS',type:'ssh',managed:true,os:'linux',control:'ssh'};
  store.state.locations.push(managed);
  const claude = store.saveRole({...store.state.roles[0],id:undefined,name:'Managed Claude Fixture',engine:'claude',provider:'native',locationId:managed.id,codexLoginSource:'isolated'});
  store.saveRole({...claude,id:undefined,name:'Shared Claude Fixture',proxyMode:'direct'});
  const disabled = store.saveRole({...claude,id:undefined,name:'Disabled Claude Fixture'});
  store.setRoleEnabled(disabled.id,false);
  services.backend.usage.claude = {state:'ready',windows:[
    {id:'model:fable',label:'Fable',usedPercent:3,resetsAt:Math.floor(Date.now()/1000)+3600},
  ],updatedAt:Date.now(),source:'claude-cli-control'};
  await js("(async()=>{state=await api.snapshot();$('usage-center-open').click();})()");
  assert.equal(await js("Boolean($('account-usage'))"), false);
  assert.equal(await js("document.querySelector('.usage-filter').value"), 'all');
  assert.equal(await js("document.querySelector('.usage-search').value"), '');
  const claudeCard = "[...document.querySelectorAll('.usage-card')].find(card => card.textContent.includes('Managed Claude Fixture'))";
  assert.equal(await js(`(${claudeCard}).querySelector('progress').value`), 3);
  assert.equal(await js(`(${claudeCard}).querySelector('.usage-role-names').textContent`), 'Managed Claude Fixture、Shared Claude Fixture');
  assert.equal(await js("$('usage-center').textContent.includes('Disabled Claude Fixture')"), false);
  await js("$('dialog-close').click()");
  const windows=require('electron').BrowserWindow.getAllWindows().length;
  services.network.environmentFor=async()=>({});services.clipboard.writeText=text=>copied.push(text);
  await js('window.Terminal=class extends window.Terminal {constructor(...args){super(...args);window.__quotaFixtureTerminal=this;}};true;');
  services.quotaConsole.spawn=(command,args,options)=>{
    const process={command,args,options,writes:[],kills:0,onData(fn){this.data=fn;setTimeout(()=>{if(!this.kills)fn('\x1b[2J\x1b[HAntigravity CLI\r\n> Plan mode\r\n? for shortcuts');},50);},onExit(fn){this.exit=fn;},write(value){this.writes.push(value);if(value==='/usage')this.data('\x1b[2J\x1b[Husage    View model quota usage\r\nenter Select');else if(value==='\r')this.data('\x1b[2J\x1b[HModels & Quota\r\nGemini Pro       Remaining 75%\r\nGemini Flash     Remaining 90%\r\nFixture quota account');},resize(cols,rows){this.size=[cols,rows];},kill(){this.kills++;this.exit?.();}};processes.push(process);return process;
  };
  const until=async predicate=>{for(let i=0;i<60;i++){if(await predicate())return;await wait(100);}throw new Error('Timed out waiting for embedded quota fixture.');};
  await js('(async()=>{state=await api.snapshot();openUsage("Native Quota Route");})()');
  assert((await js('document.querySelector("#usage-center").textContent')).includes('应用内查看额度'));
  await js('document.querySelector(".usage-card-actions button").click()');
  await until(()=>js('Boolean(document.querySelector(".native-quota-terminal .xterm-rows")?.textContent.includes("Remaining 75%"))'));
  assert.equal(require('electron').BrowserWindow.getAllWindows().length,windows);assert.equal(processes.length,1);assert.deepEqual(processes[0].writes,['/usage','\r']);assert.equal(services.quotaConsole.sessions.size,1);
  const rect=await js('(()=>{const r=document.querySelector(".native-quota-terminal").getBoundingClientRect();return {width:r.width,height:r.height};})()');assert(rect.width>650&&rect.height>220);
  await js('document.querySelector(".quota-copy").click()');assert((await js('document.querySelector(".quota-status").textContent')).includes('请先'));
  await js('window.__quotaFixtureTerminal.select(0,0,14);document.querySelector(".quota-copy").click()');await until(()=>copied.length>0);assert.equal(copied.at(-1),'Models & Quota');
  fs.writeFileSync(path.join(directory,'native-quota-embedded.png'),(await window.webContents.capturePage()).toPNG());
  const previousCols=processes[0].size?.[0];window.setContentSize(1050,760);await until(()=>processes[0].size?.[0]<previousCols);
  services.quotaConsole.sessions.values().next().value.lastStart=0;await js('document.querySelector(".quota-refresh").click()');await until(()=>processes.length===2);await until(()=>js('document.querySelector(".native-quota-terminal .xterm-rows").textContent.includes("Remaining 75%")'));assert.equal(processes[0].kills,1);
  await js('document.querySelector(".quota-back").click()');await until(()=>services.quotaConsole.sessions.size===0);assert.equal(processes[1].kills,1);assert.equal(await js('document.querySelector(".usage-overview").hidden'),false);
  await js('document.querySelector(".usage-card-actions button").click()');await until(()=>processes.length===3);await js('document.querySelector("#dialog-close").click()');await until(()=>services.quotaConsole.sessions.size===0);assert.equal(processes[2].kills,1);
  await js('openUsage("Native Quota Route")');await js('document.querySelector(".usage-card-actions button").click()');await until(()=>processes.length===4);await js('openChat(chat())');await until(()=>services.quotaConsole.sessions.size===0);assert.equal(processes[3].kills,1);
  await js('window.Terminal=class {constructor(){throw new Error("Fixture terminal initialization failure");}};openUsage("Native Quota Route");document.querySelector(".usage-card-actions button").click()');
  await until(()=>js('Boolean(document.querySelector(".native-quota-terminal")?.textContent.includes("加载失败"))'));
  await until(()=>services.quotaConsole.sessions.size===0);assert.equal(processes.length,4);
  assert.equal(await js('document.querySelector(".quota-back").hidden'),false);
  await js('document.querySelector("#dialog-close").click()');
  assert.equal(require('electron').BrowserWindow.getAllWindows().length,windows);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'native-quota-route-checks.json'),JSON.stringify({passed:true,checks:['embedded native quota terminal','unchanged native window count','official usage menu only','refresh replaces owned query','back returns to quota list','close and dialog replacement clean up query','usable terminal dimensions','selected text copying','no model call'],consoleErrors:errors},null,2));app.exit(0);
}
async function live({window,store,app,directory,services,js,errors}){
  const workspace=path.resolve(__dirname,'../../.runtime/workbench');
  const database=path.join(workspace,'workspace.sqlite');
  let saved;
  if(fs.existsSync(database)){
    const db=new (require('node:sqlite').DatabaseSync)(database,{readOnly:true});
    try{
      const records=db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY position');
      saved=Object.fromEntries(['roles','locations'].map(kind=>[kind,records.all(kind).map(row=>JSON.parse(row.data))]));
    }finally{db.close();}
  }else saved=JSON.parse(fs.readFileSync(path.join(workspace,'workspace.json'),'utf8'));
  const original=saved.roles.find(r=>r.engine==='antigravity'&&r.provider==='native'&&r.locationId==='local');assert(original);
  const local=store.state.locations.find(l=>l.id==='local');local.proxy=saved.locations.find(l=>l.id==='local').proxy;
  const role=store.saveRole({...original,id:undefined,name:'Native Quota Live Check'});
  const originalOpen=services.quotaConsole.open.bind(services.quotaConsole);
  services.quotaConsole.open=async(...args)=>{const value=await originalOpen(...args);services.quotaConsole.sessions.get(value.id).cwd=path.resolve(__dirname,'../../.runtime/workbench/quota-console-cwd');return value;};
  await js('(async()=>{state=await api.snapshot();openUsage("Native Quota Live Check");document.querySelector(".usage-card-actions button").click();})()');
  let result;
  for(let i=0;i<180;i++){
    await wait(500);result=await js('(()=>{const h=document.querySelector(".native-quota-terminal"),s=h?.innerText||"";return {hasQuota:/Models & Quota/.test(s)&&!/Loading quota summary/i.test(s)&&/remaining|reset|quota.*%|available|credits/i.test(s),hasOnboarding:/Terms of Service|Choose your color scheme|Do you trust/.test(s),hasLogin:/sign in|log in|Login required|not authenticated/i.test(s),terminalTextLength:s.length,status:document.querySelector(".quota-status")?.textContent,dialogOpen:document.querySelector("#dialog").open};})()');
    if(result.hasQuota||result.hasOnboarding||result.hasLogin)break;
  }
  fs.writeFileSync(path.join(directory,'native-quota-live.png'),(await window.webContents.capturePage()).toPNG());
  const states=[...services.quotaConsole.sessions.values()].map(item=>({stage:item.stage,active:Boolean(item.pty)}));
  await js('document.querySelector("#dialog-close").click()');await wait(100);
  fs.writeFileSync(path.join(directory,'native-quota-live-checks.json'),JSON.stringify({result,states,cleaned:services.quotaConsole.sessions.size===0,errors},null,2));
  assert(result.hasQuota,JSON.stringify({result,states,errors}));assert.deepEqual(errors,[]);app.exit(0);
}
module.exports={run};
