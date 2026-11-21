const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {QuotaConsole,quotaArgs,usageMenu}=require('../workbench/quota-console.cjs');
function fixture(t,environment=async(_r,env)=>env){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-quota-console-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));const executable=path.join(directory,'agy.exe');fs.writeFileSync(executable,'fixture');
  const role={id:'fixture',engine:'antigravity',provider:'native',locationId:'local',executable},processes=[],owner=new EventEmitter();owner.isDestroyed=()=>false;owner.events=[];owner.send=(channel,event)=>owner.events.push({channel,...event});
  const viewer=new QuotaConsole({store:{directory,get:kind=>kind==='roles'?role:{type:'local'}},agents:{environment:()=>({FIXTURE:'native-account'})},network:{environmentFor:environment},spawn:(command,args,options)=>{const process={command,args,options,writes:[],kills:0,onData(fn){this.data=fn;},onExit(fn){this.exit=fn;},write(value){this.writes.push(value);},resize(cols,rows){this.size=[cols,rows];},kill(){this.kills++;this.exit?.();}};processes.push(process);return process;}});t.after(()=>viewer.close());return {viewer,owner,processes};
}

test('Official quota menu recognition accepts the selected slash-command row without submitting other commands',()=>{
  for(const row of ['usage    View model quota usage','> /usage  View model quota usage','❯ /usage  View model quota usage'])assert(usageMenu(row+'\n↑/↓ Navigate · enter Select · tab Complete'));
  for(const row of ['> /usage','> /usage-skill  Run a model','usage skill: asks a model','> /chat  View model quota usage'])assert(!usageMenu(row+'\nenter Select'));
});
test('Embedded native quota starts only after attachment, restricts input and keeps one owner session',async t=>{
  let now=10000;t.mock.method(Date,'now',()=>now);const {viewer,owner,processes}=fixture(t);
  const replaced=await viewer.open('fixture',owner),panel=await viewer.open('fixture',owner);assert.equal(processes.length,0);assert.notEqual(replaced.id,panel.id);assert.equal(viewer.sessions.size,1);
  viewer.resize(owner,panel.id,90,24);viewer.action(owner,panel.id,'refresh');assert.equal(processes.length,1);assert.deepEqual(processes[0].args,quotaArgs());assert(!quotaArgs().includes('--prompt-interactive'));assert(!quotaArgs().includes('--dangerously-skip-permissions'));assert.equal(processes[0].options.env.FIXTURE,'native-account');assert.equal(processes[0].options.cols,90);
  viewer.action(owner,panel.id,'Run an expensive chat');viewer.action(owner,panel.id,'confirm');assert.equal(processes[0].writes.length,0);
  const intruder={isDestroyed:()=>false};for(const fn of [()=>viewer.action(intruder,panel.id,'down'),()=>viewer.screen(intruder,panel.id,'Terms of Service & Data Use'),()=>viewer.stop(intruder,panel.id),()=>viewer.resize(intruder,panel.id,80,24)])assert.throws(fn,/quota panel/);
  viewer.screen(owner,panel.id,'Terms of Service & Data Use');viewer.action(owner,panel.id,'confirm');assert.equal(processes[0].writes.at(-1),'\r');const count=processes[0].writes.length;viewer.action(owner,panel.id,'confirm');assert.equal(processes[0].writes.length,count);
  viewer.screen(owner,panel.id,'Models & Quota');viewer.action(owner,panel.id,'confirm');assert.equal(processes[0].writes.length,count);
  viewer.screen(owner,panel.id,'Antigravity CLI\n> Plan mode\n? for shortcuts');assert.equal(processes[0].writes.at(-1),'/usage');const beforeMenu=processes[0].writes.length;
  viewer.screen(owner,panel.id,'usage skill: asks a model\nenter Select');assert.equal(processes[0].writes.length,beforeMenu);
  viewer.screen(owner,panel.id,'usage    View model quota usage\nenter Select');assert.equal(processes[0].writes.at(-1),'\r');viewer.action(owner,panel.id,'down');assert.equal(processes[0].writes.at(-1),'\x1b[B');
  processes[0].data('Fixture quota');assert.equal(owner.events.at(-1).value,'Fixture quota');assert.equal(owner.events.at(-1).channel,'desk:quota');
  viewer.resize(owner,panel.id,80,22);assert.deepEqual(processes[0].size,[80,22]);viewer.resize(owner,panel.id,-1,500);assert.deepEqual(processes[0].size,[80,22]);
  now+=4000;viewer.action(owner,panel.id,'refresh');assert.equal(processes.length,2);assert.equal(processes[0].kills,1);const events=owner.events.length;processes[0].data('Stale data');assert.equal(owner.events.length,events);
  viewer.stop(owner,panel.id);assert.equal(processes[1].kills,1);assert.equal(viewer.sessions.size,0);assert.equal(owner.listenerCount('destroyed'),0);assert.equal(owner.listenerCount('did-start-navigation'),0);
});
test('Closing or reloading the owner cleans its query process without touching another owner',async t=>{
  const {viewer,owner,processes}=fixture(t),other=new EventEmitter();other.isDestroyed=()=>false;other.send=()=>{};
  const first=await viewer.open('fixture',owner),second=await viewer.open('fixture',other);viewer.action(owner,first.id,'refresh');viewer.action(other,second.id,'refresh');
  owner.emit('did-start-navigation',{},'file:///fixture',false,false);assert.equal(processes[0].kills,0);
  owner.emit('did-start-navigation',{},'file:///fixture',false,true);assert.equal(processes[0].kills,1);assert.equal(processes[1].kills,0);assert.equal(viewer.sessions.size,1);
  other.emit('destroyed');assert.equal(processes[1].kills,1);assert.equal(viewer.sessions.size,0);
});
test('Closing a panel while proxy setup is pending cannot start a detached quota process',async t=>{
  let resolve;const {viewer,owner,processes}=fixture(t,()=>new Promise(done=>resolve=done));const pending=viewer.open('fixture',owner),failure=assert.rejects(pending,/closed/);owner.emit('destroyed');resolve({});await failure;assert.equal(viewer.sessions.size,0);assert.equal(processes.length,0);
});
test('A late proxy setup result cannot replace a newer panel from the same owner',async t=>{
  const resolvers=[];const {viewer,owner,processes}=fixture(t,()=>new Promise(resolve=>resolvers.push(resolve)));
  const first=viewer.open('fixture',owner),failure=assert.rejects(first,/closed/),second=viewer.open('fixture',owner);resolvers[1]({});const panel=await second;viewer.action(owner,panel.id,'refresh');resolvers[0]({});await failure;
  assert.equal(viewer.sessions.size,1);assert.equal(processes.length,1);assert.equal(processes[0].kills,0);assert.equal(owner.listenerCount('destroyed'),1);
});
test('Quota console refuses API roles, other agents and remote locations',async()=>{
  for(const [engine,provider,type] of [['codex','native','local'],['antigravity','gemini','local'],['antigravity','native','ssh']]){const viewer=new QuotaConsole({store:{get:kind=>kind==='roles'?{engine,provider,locationId:'fixture'}:{type}},agents:{},network:{}});await assert.rejects(viewer.open('fixture'),/local Antigravity/);}
});
