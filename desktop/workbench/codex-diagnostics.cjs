const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const versions=new Map(),maxBytes=2*1024*1024;
const knownCodes=new Set(['serveroverloaded','policycapacityunavailable','contextwindowexceeded','sessionbudgetexceeded','usagelimitexceeded','ratelimitexceeded','flexunavailable','modelnotfound','httpconnectionfailed','responsestreamconnectionfailed','internalservererror','unauthorized','badrequest','invalidprompt','responsestreamdisconnected','responsetoomanyfailedattempts','other']);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value)&&!/^sk-/i.test(value)?value:undefined;
function inspect(value){
  const messages=[],codes=new Set(),requestIds=new Set();let httpStatus=null,retryAfterMs=null;
  function walk(item,depth=0){
    if(depth>4||!item)return;
    if(typeof item==='string'){const text=item.slice(0,16384).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');messages.push(text);try{const data=JSON.parse(text);if(data&&typeof data==='object')walk(data,depth+1);}catch{}return;}
    if(typeof item!=='object'||Array.isArray(item))return;
    for(const [name,data] of Object.entries(item)){
      const key=name.replace(/[_-]/g,'').toLowerCase();
      if(['message','detail','error','details','codexerrorinfo','code','type','errorcode'].includes(key)){
        if(['codexerrorinfo','code','type','errorcode'].includes(key)&&typeof data==='string'){const code=data.replace(/[_ -]/g,'').toLowerCase();if(knownCodes.has(code))codes.add(code);}
        walk(data,depth+1);
      }
      if(knownCodes.has(key)){codes.add(key);walk(data,depth+1);}
      if(['status','statuscode','httpstatus','httpstatuscode'].includes(key)&&Number.isInteger(data)&&data>=100&&data<=599)httpStatus=data;
      if(['requestid','xrequestid','xoairequestid'].includes(key)&&typeof data==='string'&&/^(?!sk-)[A-Za-z0-9_-]{8,128}$/.test(data))requestIds.add(data);
      if(key==='retryafterms'&&Number.isFinite(data)&&data>=0&&data<=3600000)retryAfterMs=data;
      if(key==='retryafter'&&Number.isFinite(data)&&data>=0&&data<=3600)retryAfterMs=data*1000;
    }
  }
  walk(value);const text=messages.join('\n');
  if(httpStatus===null){const match=/(?:unexpected status|http_status_code|status_code|\bHTTP(?:\/\d(?:\.\d)?)?)\s*[=:"\s]*([45]\d\d)\b/i.exec(text);if(match)httpStatus=Number(match[1]);}
  for(const match of text.matchAll(/(?:x-oai-request-id|x-request-id|request[_ -]id)["\s:=]+((?!sk-)[A-Za-z0-9_-]{8,128})(?![A-Za-z0-9_.-])/gi))requestIds.add(match[1]);
  const capacity=codes.has('serveroverloaded')||codes.has('policycapacityunavailable')||/selected model is at capacity|server[_ ]?overloaded|model[_ ]capacity|policy[_ ]capacity[_ ]unavailable/i.test(text);
  const badRequest=httpStatus===400||codes.has('badrequest')||/\{\s*"detail"\s*:\s*"Bad Request"\s*\}|\bBad Request\b/i.test(text);
  const catalog=/failed to refresh available models/i.test(text);
  const category=catalog?'model_catalog':capacity?'capacity':httpStatus===429||codes.has('usagelimitexceeded')||codes.has('ratelimitexceeded')||/usage.?limit|insufficient.?quota|quota.{0,30}(?:exceed|exhaust)|rate.?limit|too many requests/i.test(text)?'quota_or_rate_limit':[401,403].includes(httpStatus)||codes.has('unauthorized')||/unauthorized|authentication required|not logged in/i.test(text)?'authentication':codes.has('contextwindowexceeded')||/context.{0,30}(?:exceed|length|limit)/i.test(text)?'context':badRequest?'bad_request':/stream disconnected|connection.{0,20}(?:failed|reset|closed)|error sending request|timed out/i.test(text)||httpStatus>=500?'transport':'unknown';
  return {category,httpStatus,codes:[...codes].slice(0,8),requestIds:[...requestIds].slice(0,8),retryAfterMs};
}
function version(executable){
  try{const stat=fs.statSync(executable),key=executable+':'+stat.mtimeMs+':'+stat.size;if(versions.has(key))return versions.get(key);const result=spawnSync(executable,['--version'],{windowsHide:true,timeout:5000,encoding:'utf8'}),value=/\b\d+\.\d+\.\d+(?:[-.A-Za-z0-9]*)?/.exec(result.stdout||'')?.[0]||'unknown';versions.set(key,value);return value;}catch{return 'unknown';}
}
function create(directory,context,{limit=maxBytes}={}){
  const folder=path.join(directory,'diagnostics'),file=path.join(folder,'codex-events.jsonl'),base={};
  for(const key of ['traceId','chatId','roleId','provider','model','effort','locationType','callKind'])if(identifier(context[key]))base[key]=context[key];
  if(base.model)base.modelSource='requested';
  let attempt=0,started=0,events=0,tools=0,commands=0,stderr='',current={},disabled=false,latestFailure,latestWarning,shutdown;const observations=[];
  const observe=(source,detail)=>{observations.push({source,attempt,elapsedMs:Date.now()-started,...detail});if(observations.length>8)observations.shift();};
  const merge=(a,b)=>({category:a.category!=='unknown'?a.category:b.category,httpStatus:a.httpStatus??b.httpStatus,codes:[...new Set([...a.codes,...b.codes])].slice(0,8),requestIds:[...new Set([...a.requestIds,...b.requestIds])].slice(0,8),retryAfterMs:a.retryAfterMs??b.retryAfterMs});
  function write(event,data={}){
    if(disabled)return;
    try{fs.mkdirSync(folder,{recursive:true});const row=JSON.stringify({at:new Date().toISOString(),...base,event,attempt,...data})+'\n';if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(row)>limit){fs.rmSync(file+'.2',{force:true});if(fs.existsSync(file+'.1'))fs.renameSync(file+'.1',file+'.2');fs.renameSync(file,file+'.1');}fs.appendFileSync(file,row,{mode:0o600});}catch{disabled=true;}
  }
  return {
    begin({sessionId,resumed,compression,appPromptBytes,cliVersion='unknown'}){attempt++;started=Date.now();events=tools=commands=0;stderr='';latestFailure=latestWarning=shutdown=undefined;current={sessionId:identifier(sessionId),sessionMode:resumed?'resumed':'new',compression,appPromptBytes,cliVersion};write('attempt_start',current);},
    process(pid){if(Number.isInteger(pid)&&pid>0)write('process_start',{...current,pid});},
    event(value){events++;if(value.type==='thread.started')current.sessionId=identifier(value.thread_id);if(value.type==='item.completed'&&value.item?.type==='command_execution'&&value.item.exit_code===0)commands++;if(value.type==='item.completed'&&['command_execution','mcp_tool_call','file_change','web_search'].includes(value.item?.type))tools++;
      if(value.type==='turn.started')write('turn_start',{...current,elapsedMs:Date.now()-started});
      if(['error','turn.failed'].includes(value.type)){const detail=inspect(value);observe(value.type,detail);if(value.type==='turn.failed')latestFailure=detail;else latestWarning=detail;write(value.type==='error'?'cli_warning':'turn_failure',{...current,elapsedMs:Date.now()-started,events,toolsCompleted:tools,successfulCommands:commands,error:detail});}
      if(value.type==='turn.completed'){latestFailure=latestWarning=undefined;const usage={};for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'])if(Number.isFinite(value.usage?.[key]))usage[key]=value.usage[key];write('turn_complete',{...current,elapsedMs:Date.now()-started,events,toolsCompleted:tools,successfulCommands:commands,usage});}
    },
    stderr(value){stderr=(stderr+value).slice(-32768);let pos;while((pos=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,pos);stderr=stderr.slice(pos+1);const detail=inspect(line);if(detail.category!=='unknown'||detail.httpStatus||detail.requestIds.length){observe('stderr',detail);write('stderr_metadata',{...current,...detail,elapsedMs:Date.now()-started});}}},
    shutdown(value){if(!value)return;shutdown={reason:['normal','cleanup_timeout','nonzero_exit','signal_exit','unknown_exit'].includes(value.reason)?value.reason:'unknown_exit',exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,exitSignal:typeof value.exitSignal==='string'&&/^[A-Z][A-Z0-9]{0,19}$/.test(value.exitSignal)?value.exitSignal:null,forced:value.forced===true,exitObserved:value.exitObserved===true};for(const key of ['graceMs','afterTerminalMs'])shutdown[key]=Number.isFinite(value[key])&&value[key]>=0&&value[key]<=3600000?value[key]:null;write('process_shutdown',{...current,...shutdown,elapsedMs:Date.now()-started});},
    end(error,state,observedExitCode=null){if(stderr){this.stderr('\n');}write('attempt_end',{...current,elapsedMs:Date.now()-started,events,toolsCompleted:tools,successfulCommands:commands,protocolState:state.turnEnded||'unknown',exitCode:shutdown?.exitObserved?shutdown.exitCode:Number.isInteger(error?.exitCode)?error.exitCode:Number.isInteger(observedExitCode)?observedExitCode:null,...(shutdown?{shutdown}:{}),error:error||state.turnEnded==='failed'?merge(latestFailure||inspect(state.error||state.warning||error?.message),inspect(error?.message)):null});},
    finish(message){let failure=message.status==='failed'?inspect(message.note):null;if(failure){if(latestFailure)failure=merge(latestFailure,failure);else if(latestWarning)failure=merge(latestWarning.category==='capacity'&&['bad_request','unknown'].includes(failure.category)?latestWarning:failure,latestWarning);}
      const value={...base,attempts:attempt,lastAttempt:{...current},metadataOnly:true,observations:[...observations],...(shutdown?{shutdown}:{}) ,...(failure?{failure}:{})};message.diagnostics=value;write('job_end',{status:message.status,...(failure?{error:failure}:{})});value.localLogWritten=!disabled;return value;}
  };
}
module.exports={inspect,create,version,maxBytes};
