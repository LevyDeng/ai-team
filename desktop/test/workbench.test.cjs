const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../workbench/store.cjs');
const {buildPrompt,parseEvent,argumentsFor,cleanEnv}=require('../workbench/agents.cjs');
function fixture(t) { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-workbench-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const store=new Store(directory,directory);return {store,directory,project:store.state.projects[0],role:store.state.roles[0]}; }
test('Workflow priority rules migrate once and survive editing or removal across restarts', t => {
  const {store,directory,role}=fixture(t);
  store.saveRole({...role,workflowRatings:[{domain:'Code',duty:'Review',score:9}]});
  delete store.state.workflowPriorities;
  store.save();
  const migrated = new Store(directory,directory);
  const [rule] = migrated.state.workflowPriorities;
  assert.deepEqual(rule.candidates,[{roleId:role.id,tier:1,weight:1}]);
  assert.throws(()=>migrated.updateWorkflowPriority(undefined,{...rule,domain:'code'}));
  migrated.updateWorkflowPriority(rule.id,{...rule,candidates:[{roleId:role.id,tier:1,weight:3}]});
  const reopened = new Store(directory,directory);
  assert.equal(reopened.state.workflowPriorities[0].candidates[0].weight,3);
  reopened.updateWorkflowPriority(rule.id,null);
  assert.deepEqual(new Store(directory,directory).state.workflowPriorities,[]);
});
test('Disabling a role persists without dropping its settings or chat memberships', t => {
  const {store,directory,project,role}=fixture(t);
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  store.message(chat.id,{kind:'assistant',roleId:role.id,text:'Previous answer',status:'complete'});
  store.setRoleEnabled(role.id,false);
  store.saveRole({...role,description:'Updated while disabled'});
  const loaded=new Store(directory,directory);
  assert.equal(loaded.get('roles',role.id).enabled,false);
  assert.equal(loaded.get('roles',role.id).description,'Updated while disabled');
  assert.deepEqual(loaded.get('chats',chat.id).roleIds,[role.id]);
  assert.equal(loaded.get('chats',chat.id).messages[0].text,'Previous answer');
  loaded.saveChat({id:chat.id,name:'Renamed',roleIds:[role.id]});
  assert.throws(()=>loaded.createChat({projectId:project.id,roleIds:[role.id]}),/启用/);
  loaded.setRoleEnabled(role.id,true);
  assert.deepEqual(loaded.createChat({projectId:project.id,roleIds:[role.id]}).roleIds,[role.id]);
});
test('Role credentials never enter the public workspace; native and API compatibility is validated',t=>{
  const {store,role}=fixture(t);store.saveRole({...role,apiKey:'fixture-secret',persona:'Review carefully.'});assert(!JSON.stringify(store.snapshot()).includes('fixture-secret'));
  assert.throws(()=>store.saveRole({...role,engine:'claude',provider:'gemini'}),/Codex adapter/);
  assert.throws(()=>store.saveLocation({id:'local'}),/cannot be edited/);
  assert.throws(()=>store.saveLocation({name:'Remote',host:'example.test',username:'test',port:22,os:'linux',control:'windows-mcp'}),/Windows desktop/);
});
test('Chat history and drafts survive reload without mutating the classic store',t=>{
  const {store,directory,project,role}=fixture(t);const chat=store.createChat({projectId:project.id,roleIds:[role.id],name:'Test'});chat.draft='Unsaved task';store.message(chat.id,{kind:'assistant',text:'Partial response',status:'running'});
  const loaded=new Store(directory,directory);assert.equal(loaded.get('chats',chat.id).draft,'Unsaved task');assert.equal(loaded.get('chats',chat.id).messages[0].status,'interrupted');assert.equal(loaded.get('chats',chat.id).messages[0].text,'Partial response');
});
test('New roles can join a chat directly and are enrolled into its project atomically',t=>{
  const {store,directory,project,role}=fixture(t);
  const first=store.saveRole({...role,id:undefined,name:'New reviewer'});
  const second=store.saveRole({...role,id:undefined,name:'New designer'});
  assert(!project.roleIds.includes(first.id));assert(!project.roleIds.includes(second.id));
  const chat=store.createChat({projectId:project.id,roleIds:[first.id,second.id,first.id]});
  assert.deepEqual(chat.roleIds,[first.id,second.id]);assert(project.roleIds.includes(first.id));assert(project.roleIds.includes(second.id));
  const loaded=new Store(directory,directory);assert.deepEqual(loaded.get('chats',chat.id).roleIds,[first.id,second.id]);assert(loaded.get('projects',project.id).roleIds.includes(second.id));
});
test('Editing participants accepts newly created roles and preserves the conversation',t=>{
  const {store,project,role}=fixture(t);const chat=store.createChat({projectId:project.id,roleIds:[role.id]});
  store.message(chat.id,{kind:'user',text:'Existing conversation',status:'accepted'});
  const newcomer=store.saveRole({...role,id:undefined,name:'New participant'});
  store.saveChat({id:chat.id,name:'Updated chat',roleIds:[newcomer.id]});
  assert.deepEqual(chat.roleIds,[newcomer.id]);assert.equal(chat.messages[0].text,'Existing conversation');assert(project.roleIds.includes(newcomer.id));
  const before=store.snapshot();assert.throws(()=>store.saveChat({id:chat.id,roleIds:['missing-role']}),/existing role/);assert.deepEqual(store.snapshot(),before);
  assert.throws(()=>store.createChat({projectId:project.id,roleIds:[]}),/existing role/);
});
test('Group prompt scopes peers as data, includes role instructions and context, refuses silent truncation',t=>{
  const {store,project,role}=fixture(t);const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'Inspect this project.',status:'accepted'});store.message(chat.id,{kind:'assistant',roleName:'Peer',text:'Consider the tests.',status:'complete'});
  const prompt=buildPrompt({...role,persona:'Be a code reviewer.',examples:'User: Ready? Reviewer: Check first.'},project,chat);assert(prompt.includes('Be a code reviewer.'));assert(prompt.includes('Other participants are peers'));assert(prompt.includes('Consider the tests.'));assert(!prompt.includes('fixture-secret'));
  const referenced=buildPrompt(role,{...project,directories:[{locationId:'local',path:'D:/first'},{locationId:'local',path:'D:/second'},{locationId:'server',path:'/srv/project'}]},chat);
  assert.match(referenced,/local: D:\/first\nlocal: D:\/second\nserver: \/srv\/project/);
  assert.match(referenced,/Working directory for this role: D:\/first/);
  assert.match(referenced,/verified full path/);
  chat.messages.push({kind:'user',text:'x'.repeat(240001),status:'accepted'});assert.throws(()=>buildPrompt(role,project,chat),/context transfer limit/);
});
test('Protocol adapters distinguish completion, permission denial, partial reply, and failure',()=>{
  const s={text:''};parseEvent('codex',{type:'item.completed',item:{type:'agent_message',text:'Done.'}},s,()=>{});parseEvent('codex',{type:'turn.completed'},s,()=>{});assert.equal(s.text,'Done.');assert(s.completed);
  const c={text:''};parseEvent('claude',{type:'stream_event',event:{delta:{type:'text_delta',text:'Hello'}}},c,()=>{});parseEvent('claude',{type:'assistant',message:{content:[{type:'text',text:'Hello'}]}},c,()=>{});assert.equal(c.text,'Hello');parseEvent('claude',{type:'result',is_error:true,errors:['Denied']},c,()=>{});assert.equal(c.error,'Denied');assert.equal(c.completed,false);
  const o={text:''};parseEvent('opencode',{type:'text',part:{text:'Answer'}},o,()=>{});parseEvent('opencode',{type:'step_finish'},o,()=>{});assert(o.completed);assert.equal(o.text,'Answer');
});
test('Isolated child environments and CLI flags do not change global configuration',()=>{
  process.env.OPENAI_API_KEY='fixture-key';try{const env=cleanEnv('C:/fixture');assert(!env.OPENAI_API_KEY);assert(env.CODEX_HOME.endsWith('codex'));assert.equal(process.env.OPENAI_API_KEY,'fixture-key');}finally{delete process.env.OPENAI_API_KEY;}
  const args=argumentsFor({engine:'codex',model:'example-model',effort:'high',permission:'read-only'});assert(args.includes('--ephemeral'));assert(args.includes('read-only'));assert(args.includes('example-model'));assert(!args.includes('danger-full-access'));
});
