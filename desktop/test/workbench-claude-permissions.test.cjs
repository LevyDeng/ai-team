const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {Store}=require('../workbench/store.cjs');
const {Agents,argumentsFor,parseEvent}=require('../workbench/agents.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-claude-permissions-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));const store=new Store(directory,directory);return {store,directory};}
test('Claude permission selection persists per role without elevating other roles or changing legacy defaults',t=>{
  const {store,directory}=fixture(t),base=store.state.roles[0],other=store.state.roles[1];
  const role=store.saveRole({...base,id:undefined,name:'Claude fixture',engine:'claude',provider:'native',permission:'danger-full-access'});
  const loaded=new Store(directory,directory);assert.equal(loaded.get('roles',role.id).permission,'danger-full-access');assert.equal(loaded.get('roles',other.id).permission,'acceptEdits');assert.equal(loaded.get('roles',base.id).permission,'workspace-write');
  for(const permission of ['workspace-write','read-only','acceptEdits'])assert.equal(store.saveRole({...role,permission}).permission,permission);
  assert.throws(()=>store.saveRole({...role,permission:'bypass-everything'}),/permission/);
});
test('Claude arguments use native permission modes without affecting models, thinking or prompt text',()=>{
  for(const [permission,mode] of [[undefined,'acceptEdits'],['acceptEdits','acceptEdits'],['workspace-write','acceptEdits'],['read-only','plan'],['danger-full-access','bypassPermissions']]){
    const args=argumentsFor({engine:'claude',permission,model:'fixture-model',effort:'high'});assert.equal(args[args.indexOf('--permission-mode')+1],mode);assert.equal(args.filter(x=>x==='--permission-mode').length,1);assert(args.includes('--no-session-persistence'));assert.equal(args[args.indexOf('--model')+1],'fixture-model');assert.equal(args[args.indexOf('--effort')+1],'high');
  }
  for(const permission of ['unsupported','constructor','__proto__'])assert.throws(()=>argumentsFor({engine:'claude',permission}),/permission/);
});
test('Managed and ordinary SSH execution forward Claude permissions and isolate workflow routing',async t=>{
  const {store}=fixture(t),project=store.state.projects[0],requests=[];
  store.state.locations.push({id:'fixture-vps',type:'ssh',name:'Fixture VPS',managed:true,os:'linux',control:'ssh'});project.directories=[{locationId:'fixture-vps',path:'/srv/fixture-project'}];
  const locations={exec:async()=>String(1024*1024),runner:async()=>({file:'/tmp/fixture-runner.py',client:{exec:(_command,callback)=>{
    const stream=new EventEmitter();stream.stderr=new PassThrough();stream.close=()=>{};
    stream.write=data=>{const request=JSON.parse(data);requests.push(request);setImmediate(()=>{stream.emit('data',Buffer.from(JSON.stringify({type:'result',is_error:false,result:'CLAUDE_PERMISSION_FIXTURE',permission_denials:request.command.includes('bypassPermissions')?[]:[{tool_name:'Bash'}]})+'\n'));stream.emit('close',0);});};callback(null,stream);
  }}})};
  const agents=new Agents(store,{get:()=>''},locations,()=>{});t.after(()=>agents.close());
  for(const managed of [true,false]){
    store.get('locations','fixture-vps').managed=managed;
    for(const [permission,mode] of [['workspace-write','acceptEdits'],['danger-full-access','bypassPermissions'],['read-only','plan']]){
      const role=store.saveRole({...store.state.roles[0],id:undefined,name:'Remote fixture',engine:'claude',provider:'native',locationId:'fixture-vps',permission,allowLocationTools:false});
      const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Fixture remote task',status:'accepted'});
      const result=await agents.run(chat.id,role,project,new AbortController().signal),request=requests.at(-1);
      assert.equal(result.status,'complete',result.note);assert.equal(request.managed,managed);assert.equal(request.command[request.command.indexOf('--permission-mode')+1],mode);assert.equal(result.permission,permission);assert.equal(result.text,'CLAUDE_PERMISSION_FIXTURE');assert.equal(request.cwd,'/srv/fixture-project');
      if(permission==='danger-full-access')assert.equal(result.warningCode,undefined);else{assert.equal(result.warningCode,'CLAUDE_PERMISSION_DENIED');assert(!result.note.includes('project terminal'));}
    }
    const host=store.saveRole({...store.state.roles[0],id:undefined,name:'Remote host',engine:'claude',provider:'native',locationId:'fixture-vps',permission:'danger-full-access',allowLocationTools:true});
    const chat=store.createChat({projectId:project.id,roleIds:[host.id]});
    const result=await agents.run(chat.id,host,project,new AbortController().signal,false,{moderatorTask:{kind:'workflow-route',prompt:'Choose the next participant'}});
    const request=requests.at(-1);
    assert.equal(result.permission,'read-only');
    assert.equal(result.nativeSession,undefined);
    assert.equal(request.command[request.command.indexOf('--max-turns')+1],'1');
    assert.equal(request.command[request.command.indexOf('--tools')+1],'');
    assert.equal(request.command.includes('mcp__windows-mcp__*'),managed);
    assert.equal(request.command.includes('--allowedTools'),false);
    assert.deepEqual(request.mcpTargets,[]);
    const before = store.snapshot().chats;
    const plan = await agents.run(null,host,project,new AbortController().signal,false,{moderatorTask:{kind:'workflow-plan',prompt:'Plan the task without running it'}});
    assert.equal(plan.status,'complete');
    assert.equal(plan.permission,'read-only');
    assert.equal(plan.nativeSession,undefined);
    assert.deepEqual(store.snapshot().chats,before);
  }
});
test('Permission-denied replies retain their useful content and explain that another process cannot approve an ended request',()=>{
  const state={text:'Partial useful reply'};parseEvent('claude',{type:'result',is_error:false,permission_denials:[{tool_name:'Bash'}]},state,()=>{});assert.equal(state.text,'Partial useful reply');assert.equal(state.completed,true);assert.equal(state.permissionDenied,true);assert(state.note.includes('another process'));
});
