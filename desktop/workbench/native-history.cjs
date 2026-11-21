const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function textParts(content){return typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p&&['text','input_text','output_text'].includes(p.type)&&typeof p.text==='string').map(p=>p.text).join('\n\n'):'';}
function displayEvent(engine,row){
  if(!row||row.isMeta||row.isCompactSummary||row.parent_tool_use_id)return null;
  const stamp=Date.parse(row.timestamp)||undefined;
  if(engine==='claude'){
    if(row.type==='system'&&row.subtype==='turn_duration')return {state:'completed'};
    if(row.type==='api-request')return {state:'running'};
    if(!['user','assistant'].includes(row.type))return null;
    const message=row.message||{},content=message.content,text=textParts(content);
    const waiting=Array.isArray(content)&&content.some(p=>p?.type==='tool_use'&&['AskUserQuestion','ExitPlanMode'].includes(p.name));
    if(!text.trim())return waiting?{state:'waiting'}:row.type==='assistant'?{state:'running'}:null;
    if(row.type==='user'&&/^<(?:local-command|command-name|system-reminder|bash-input|bash-stdout|bash-stderr)/.test(text.trim()))return null;
    return {kind:row.type,text,at:stamp,key:row.type==='assistant'?(message.id||row.uuid):(row.uuid||message.id),model:message.model,family:'message',state:waiting?'waiting':row.type==='user'?'running':message.stop_reason==='end_turn'?'completed':'running'};
  }
  const payload=row.payload||{};
  if(row.type==='event_msg'){
    const state={task_started:'running',task_complete:'completed',turn_aborted:'interrupted',error:'failed'}[payload.type];
    if(state)return {state};
    if(!['user_message','agent_message'].includes(payload.type)||typeof payload.message!=='string')return null;
    return {kind:payload.type==='user_message'?'user':'assistant',text:payload.message,at:stamp,key:payload.id,family:'event',state:payload.type==='user_message'?'running':payload.phase==='final_answer'?'completed':'running'};
  }
  if(row.type==='response_item'&&payload.type==='message'&&['user','assistant'].includes(payload.role)){
    const text=textParts(payload.content);if(!text.trim())return null;
    if(payload.role==='user'&&/^<(?:environment_context|INSTRUCTIONS)>|^# AGENTS\.md instructions/.test(text.trim()))return null;
    return {kind:payload.role,text,at:stamp,key:payload.id,family:'response',state:payload.role==='user'?'running':payload.phase==='final_answer'?'completed':'running'};
  }
  return null;
}
function candidates(root,engine,session,originator,start,exactSession=false){
  if(!root)return [];
  if(engine==='claude'){
    const projects=path.join(root,'projects');try{return fs.readdirSync(projects,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(projects,e.name,session+'.jsonl')).filter(f=>fs.existsSync(f)&&!fs.lstatSync(f).isSymbolicLink());}catch{return [];}
  }
  const files=[];
  for(const time of [Date.now(),Date.now()-86400000,start,start-86400000,start+86400000]){
    const date=new Date(time);if(!Number.isFinite(date.getTime()))continue;
    const folder=path.join(root,'sessions',String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0'));
    try{for(const item of fs.readdirSync(folder,{withFileTypes:true}))if(item.isFile()&&/^rollout-.*\.jsonl$/.test(item.name))files.push(path.join(folder,item.name));}catch{}
  }
  return [...new Set(files)].filter(file=>{
    try{if(!exactSession&&fs.statSync(file).mtimeMs<start-5000)return false;const fd=fs.openSync(file,'r');let prefix;try{const b=Buffer.alloc(65536);prefix=b.subarray(0,fs.readSync(fd,b)).toString('utf8');}finally{fs.closeSync(fd);}const first=JSON.parse(prefix.split('\n')[0]);return first.type==='session_meta'&&(exactSession?first.payload?.id===session:first.payload?.originator===originator);}catch{return false;}
  });
}
class NativeHistory {
  constructor(options){Object.assign(this,options);this.offset=0;this.oversize=false;this.start||=Date.now();}
  poll(){
    if(!this.file){const files=candidates(this.root,this.engine,this.session,this.originator,this.start,this.exactSession);if(files.length!==1)return;this.file=files[0];if(this.fromEnd){this.offset=fs.statSync(this.file).size;this.fromEnd=false;}}
    let fd;try{
      fd=fs.openSync(this.file,'r');const stat=fs.fstatSync(fd);if(stat.size<this.offset)this.offset=0;
      const data=Buffer.alloc(Math.min(2*1024*1024,Math.max(0,stat.size-this.offset)));if(!data.length)return;
      const length=fs.readSync(fd,data,0,data.length,this.offset);let start=0;
      for(let n=0;n<length;n++)if(data[n]===10){const pos=this.offset+start;if(!this.oversize&&n-start<=1024*1024){let row;try{row=JSON.parse(data.subarray(start,n).toString('utf8'));}catch{}if(row)this.event(row,String(pos));}this.oversize=false;start=n+1;}
      this.offset+=start;
      if(length-start>1024*1024){this.offset+=length-start;this.oversize=true;}
    }catch(error){this.error?.(error);}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
}
function eventKey(value){return crypto.createHash('sha256').update(value).digest('hex').slice(0,24);}
module.exports={NativeHistory,displayEvent,eventKey};
