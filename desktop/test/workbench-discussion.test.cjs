const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const discussion=require('../workbench/discussion.cjs');
const {Store}=require('../workbench/store.cjs');
const {Agents,buildPrompt}=require('../workbench/agents.cjs');
const control={token:'a'.repeat(32),round:1,maxRounds:10,position:1,participants:2};
const frame=(body,token=control.token)=>`<relay_discussion_${token}>${body}</relay_discussion_${token}>`;
const vote=decision=>({decision,reason:'Fixture assessment'});
async function simulate(options={}){
  const calls=[],controller=options.controller||new AbortController();
  const result=await discussion.run({roleIds:['first','last'],rounds:10,autoStop:true,signal:controller.signal,...options,
    runTurn:async(id,context)=>{calls.push({id,context});return options.turn?options.turn(id,context,calls):{status:'complete',discussionVote:vote('complete')};}});
  return {result,calls};
}
test('Unanimous completion ends after a full round, with unique per-turn control tokens',async()=>{
  const {result,calls}=await simulate();assert.equal(result.state,'complete');assert.equal(result.rounds,1);assert.deepEqual(calls.map(x=>x.id),['first','last']);
  assert.notEqual(calls[0].context.token,calls[1].context.token);assert.equal(calls[1].context.position,2);assert.equal(calls[1].context.maxRounds,10);
});
test('A material open issue continues, then unanimous completion stops before the ceiling',async()=>{
  const {result,calls}=await simulate({turn:async(id,c)=>({status:'complete',discussionVote:vote(c.round===1&&id==='first'?'continue':'complete')})});
  assert.equal(result.state,'complete');assert.equal(result.rounds,2);assert.equal(calls.length,4);
});
test('User input, missing decisions, and exhausted ceilings have distinct outcomes',async()=>{
  const needs=await simulate({turn:async id=>({status:'complete',discussionVote:vote(id==='first'?'needs_user':'complete')})});assert.equal(needs.result.state,'needs_user');assert.equal(needs.calls.length,2);
  const missing=await simulate({turn:async id=>({status:'complete',discussionVote:id==='first'?null:vote('complete')})});assert.equal(missing.result.state,'unconfirmed');assert.equal(missing.calls.length,2);
  const limit=await simulate({rounds:2,turn:async()=>({status:'complete',discussionVote:vote('continue')})});assert.equal(limit.result.state,'limit');assert.equal(limit.calls.length,4);
});
test('Fixed mode needs no votes and invokes only its specified number of rounds',async()=>{
  const {result,calls}=await simulate({rounds:3,autoStop:false,turn:async()=>({status:'complete'})});assert.equal(result.state,'limit');assert.equal(calls.length,6);assert(calls.every(x=>x.context===null));
});
test('A one-round discussion has no ending vote or moderator review; only non-final rounds need a decision',async()=>{
  const calls=[];
  const single=await discussion.run({roleIds:['first','last'],rounds:1,autoStop:true,signal:new AbortController().signal,runTurn:async(id,control)=>{assert.equal(control,null);calls.push(id);return {status:'complete'};},reviewRound:()=>assert.fail('One round needs no extra reviewer')});
  assert.equal(single.state,'limit');assert.deepEqual(calls,['first','last']);
  let reviews=0;const final=await discussion.run({roleIds:['first'],rounds:2,autoStop:true,signal:new AbortController().signal,runTurn:async()=>({status:'complete'}),reviewRound:async()=>{reviews++;return {status:'complete',decision:'continue',reason:'Another participant round is useful.'};}});
  assert.equal(final.state,'limit');assert.equal(reviews,1);
});
test('Pause, cancellation and failure stop later roles without reporting a completed partial round',async()=>{
  for(const status of ['cancelled','failed']){const {result,calls}=await simulate({turn:async()=>({status})});assert.equal(calls.length,1);assert.equal(result.rounds,0);assert.equal(result.state,status==='failed'?'failed':'paused');}
  const controller=new AbortController();const {result,calls}=await simulate({controller,turn:async()=>{controller.abort();return {status:'complete',discussionVote:vote('complete')};}});assert.equal(result.state,'paused');assert.equal(calls.length,1);
  const stopped=await simulate({controller});assert.equal(stopped.calls.length,0);
});
test('Only an exact final status frame is accepted; streaming metadata never becomes answer text',()=>{
  const metadata=frame(JSON.stringify(vote('complete'))),raw='Useful answer\n'+metadata;
  assert.deepEqual(discussion.project(raw,control,true),{text:'Useful answer',vote:vote('complete')});
  for(let end='Useful answer\n'.length+1;end<raw.length;end++)assert(!discussion.project(raw.slice(0,end),control).text.includes('relay_discussion'));
  assert.equal(discussion.project('Useful answer\n<relay_dis',control,true).text,'Useful answer\n');
  assert.equal(discussion.project(raw+'\n[complete]',control).text,'Useful answer\n[complete]');
  assert.equal(discussion.project(raw+' quoted example',control,true).vote,null);
  const repeated=discussion.project(raw+'\n'+metadata,control,true);assert.equal(repeated.vote,null);assert(!repeated.text.includes('relay_discussion'));
  for(const body of ['bad json','{}','{"decision":"done","reason":"x"}','{"decision":"complete","reason":""}','{"decision":"complete","reason":"x","unexpected":1}'])assert.equal(discussion.project('Answer'+frame(body),control,true).vote,null);
  const other=frame(JSON.stringify(vote('complete')),'b'.repeat(32));assert.equal(discussion.project(other,control,true).text,other);
});
test('Round limits are validated and saved per chat independently across reloads',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-discussion-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const store=new Store(directory,directory),project=store.state.projects[0],role=store.state.roles[0];
  const a=store.createChat({projectId:project.id,roleIds:[role.id]}),b=store.createChat({projectId:project.id,roleIds:[role.id]});
  store.saveChatDiscussion(a.id,{maxRounds:12,autoStop:false});
  for(const maxRounds of [0,-1,51,1.5,NaN,Infinity,''])assert.throws(()=>store.saveChatDiscussion(a.id,{maxRounds,autoStop:true}),/between/);
  assert.throws(()=>store.saveChatDiscussion(a.id,{maxRounds:5,autoStop:'yes'}));assert.equal(a.maxRounds,12);assert.equal(a.autoStop,false);
  const loaded=new Store(directory,directory);assert.equal(loaded.get('chats',a.id).maxRounds,12);assert.equal(loaded.get('chats',a.id).autoStop,false);assert.equal(loaded.get('chats',b.id).maxRounds,1);assert.equal(loaded.get('chats',b.id).autoStop,true);
});
test('Discussion control is absent from ordinary prompts and summaries',()=>{
  const role={id:'first',name:'Fixture'},project={name:'Fixture',directories:[]},chat={messages:[],discussion:control};
  assert(buildPrompt(role,project,chat).includes(control.token));assert(!buildPrompt(role,project,{messages:[]}).includes('Application discussion control'));assert(!buildPrompt(role,project,chat,true).includes(control.token));
});
test('Real agent adapter saves clean answer and terminal text, with structured decision only',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-discussion-agent-'));t.after(()=>fs.promises.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const store=new Store(directory,directory),project=store.state.projects[0],agents=new Agents(store,{get:()=>''},{},()=>{});t.after(()=>agents.close());
  const role=store.saveRole({...store.state.roles[0],id:undefined,engine:'codebuddy',provider:'native',executable:path.join(__dirname,'fixtures/acp-agent.cjs'),model:'fixture-model',permission:'read-only',allowLocationTools:false,codexLoginSource:'isolated'});
  const chat=store.createChat({projectId:project.id,roleIds:[role.id]});store.message(chat.id,{kind:'user',text:'discussion-fixture',status:'accepted'});
  const result=await agents.run(chat.id,role,project,new AbortController().signal,false,{discussion:control});
  assert.equal(result.status,'complete',result.note);assert.equal(result.text,'Discussion fixture answer');assert.equal(result.discussionVote.decision,'complete');assert(!result.terminal.includes('relay_discussion'));assert(!fs.readFileSync(store.file,'utf8').includes(control.token));
});
