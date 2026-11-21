const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const {atomic}=require('./store.cjs');
const {findExecutable}=require('./agents.cjs');
const {usesDesktopLogin,sharedProcessArgs}=require('./desktop-login.cjs');
const {fileAuthArgs}=require('./native-auth.cjs');
const guides={codex:'https://chatgpt.com/codex/settings/usage',claude:'https://claude.ai/settings/usage',antigravity:'https://antigravity.google/docs/cli/commands/usage/',kimi:'https://www.kimi.com/code/console',cursor:'https://cursor.com/dashboard/usage',codebuddy:'https://www.codebuddy.ai/docs/cli/slash-commands',workbuddy:'https://www.codebuddy.cn/workbuddy/',openai:'https://platform.openai.com/usage',gemini:'https://aistudio.google.com/usage',deepseek:'https://platform.deepseek.com/usage',moonshot:'https://platform.kimi.com/console/account'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const percent=value=>finite(value)&&value>=0&&value<=100;
function seconds(value){if(finite(value)&&value>0)return value;if(typeof value==='string'){const time=Date.parse(value);if(Number.isFinite(time))return time/1000;}return null;}
function normalize(value={}){
  const windows=(Array.isArray(value.windows)?value.windows:[]).filter(w=>w&&percent(w.usedPercent)).slice(0,20).map(w=>({id:String(w.id||'quota').slice(0,100),label:String(w.label||'Quota').slice(0,100),usedPercent:w.usedPercent,resetsAt:seconds(w.resetsAt),windowMinutes:finite(w.windowMinutes)&&w.windowMinutes>0?w.windowMinutes:null}));
  const balances=(Array.isArray(value.balances)?value.balances:[]).filter(b=>b&&['CNY','USD'].includes(b.currency)&&typeof b.remaining==='string'&&/^-?\d{1,16}(?:\.\d{1,12})?$/.test(b.remaining)).slice(0,4).map(b=>({currency:b.currency,remaining:b.remaining}));
  return {state:['ready','pending','unsupported','not_signed_in','error'].includes(value.state)?value.state:'error',windows,balances,updatedAt:finite(value.updatedAt)?value.updatedAt:null,source:['codex-app-server','claude-cli-control','claude-statusline','deepseek-api','moonshot-api'].includes(value.source)?value.source:'',cached:value.cached===true,reason:['not_loaded','manual_only','api_console','custom_endpoint','auth_required','query_failed','query_timeout','usage_unavailable','server_busy','waiting_for_claude','not_signed_in','usage_unsupported'].includes(value.reason)?value.reason:''};
}
function codexUsage(payload){
  let buckets=payload?.rateLimitsByLimitId;if(!buckets||!Object.keys(buckets).length)buckets=payload?.rateLimits?{codex:payload.rateLimits}:{};
  const windows=[];
  for(const [id,bucket] of Object.entries(buckets).slice(0,10))for(const key of ['primary','secondary']){const item=bucket?.[key];if(item&&percent(item.usedPercent))windows.push({id:id+':'+key,label:String(bucket.limitName||id)+(key==='primary'?' · Primary':' · Secondary'),usedPercent:item.usedPercent,resetsAt:item.resetsAt,windowMinutes:item.windowDurationMins});}
  return normalize({state:windows.length?'ready':'unsupported',windows,updatedAt:Date.now(),source:'codex-app-server',reason:windows.length?'':'usage_unavailable'});
}
function claudeUsage(payload){
  const rate=payload?.rate_limits||{},windows=[];
  for(const [id,label,minutes] of [['five_hour','5h',300],['seven_day','7d',10080]]){const item=rate[id];if(item&&percent(item.utilization))windows.push({id,label,usedPercent:item.utilization,resetsAt:seconds(item.resets_at),windowMinutes:minutes});}
  if(Array.isArray(rate.model_scoped))for(const item of rate.model_scoped.slice(0,12))if(typeof item.display_name==='string'&&percent(item.utilization))windows.push({id:'model:'+item.display_name,label:item.display_name,usedPercent:item.utilization,resetsAt:seconds(item.resets_at),windowMinutes:10080});
  return normalize({state:windows.length?'ready':'unsupported',windows,updatedAt:Date.now(),source:'claude-cli-control',reason:windows.length?'':'usage_unavailable'});
}
function queryNative(role,env,cwd,{executable=findExecutable(role),timeout=25000,children=new Set(),launch=spawn}={}){
  const codex=role.engine==='codex';
  const args=codex?[...(usesDesktopLogin(role)?sharedProcessArgs:fileAuthArgs),'app-server','--listen','stdio://','-c','check_for_update_on_startup=false','-c','features.plugins=false','-c','features.hooks=false']:
    ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','','--settings','{"disableAllHooks":true}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools',''];
  if(!['codex','claude'].includes(role.engine)||/\.cmd$/i.test(executable))return Promise.reject(new Error('Unsupported quota runtime.'));
  return new Promise((resolve,reject)=>{
    const child=launch(executable,args,{env,cwd,windowsHide:true,stdio:['pipe','pipe','ignore']});children.add(child);
    const decoder=new StringDecoder('utf8');let buffer='',size=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);children.delete(child);child.stdin.end();child.kill();error?reject(error):resolve(value);};
    const fail=()=>finish(new Error('Quota query failed.'));
    const timer=setTimeout(()=>finish(new Error('Quota query timed out.')),timeout);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdin.on('error',()=>{});child.once('error',fail);child.once('exit',()=>{if(!done)fail();});
    child.stdout.on('data',chunk=>{
      if(done)return;size+=chunk.length;if(size>2*1024*1024)return fail();buffer+=decoder.write(chunk);
      try{let index;while((index=buffer.indexOf('\n'))>=0&&!done){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;const m=JSON.parse(line);
        if(codex){if(![1,2].includes(m.id))continue;if(m.error){if(m.error.code===-32601)finish(null,normalize({state:'unsupported',reason:'usage_unsupported'}));else fail();continue;}if(m.id===1){send({method:'initialized',params:{}});send({id:2,method:'account/rateLimits/read',params:{}});}else finish(null,codexUsage(m.result));}
        else{if(m.type!=='control_response')continue;const r=m.response||{};if(!['usage-init','usage-read'].includes(r.request_id))continue;if(r.subtype!=='success'){finish(null,normalize({state:'unsupported',reason:'usage_unavailable'}));continue;}if(r.request_id==='usage-init')send({type:'control_request',request_id:'usage-read',request:{subtype:'get_usage',skip_behaviors:true}});else finish(null,claudeUsage(r.response));}
      }}catch{fail();}
    });
    send(codex?{id:1,method:'initialize',params:{clientInfo:{name:'relay_desk_usage',version:'0.1.0'}}}:{type:'control_request',request_id:'usage-init',request:{subtype:'initialize'}});
  });
}
class Usage {
  constructor({store,vault,agents,locations,backend,network,emit=()=>{},native=queryNative}){Object.assign(this,{store,vault,agents,locations,backend,network,emit,native});this.cache={};this.pending=new Map();this.attempts=new Map();this.versions=new Map();this.children=new Set();this.file=path.join(store.directory,'account-usage.json');try{const data=JSON.parse(fs.readFileSync(this.file,'utf8'));for(const [key,value] of Object.entries(data))if(/^[a-f0-9]{64}$/.test(key))this.cache[key]=normalize({...value,cached:true});}catch{}}
  descriptor(role){
    const location=this.store.get('locations',role.locationId),native=role.provider==='native';
    const managed=native&&location.managed&&['claude','codex'].includes(role.engine);
    const refreshable=managed||native&&location.type==='local'&&['claude','codex'].includes(role.engine)||!native&&location.type==='local'&&['deepseek','moonshot'].includes(role.provider)&&this.endpoint(role)!==null;
    const env=native&&location.type==='local'?this.agents.environment(role,path.join(this.store.directory,'profiles',role.id)):{};
    const home=managed?'managed':!native||location.type!=='local'?role.id:role.engine==='codex'?env.CODEX_HOME:role.engine==='claude'?env.CLAUDE_CONFIG_DIR:role.engine==='antigravity'?env.XDG_CONFIG_HOME||'native-google':env.KIMI_CODE_HOME||env.CODEBUDDY_CONFIG_DIR||env.WORKBUDDY_CONFIG_DIR||env.CURSOR_CONFIG_DIR||role.id;
    const credential=native?'':this.vault.values?.['api:'+role.id]||this.vault.get('api:'+role.id)||'';
    const id=crypto.createHash('sha256').update(JSON.stringify([role.engine,role.provider,location.id,home,role.executable||'',role.baseUrl||'',this.network?.policy(role),credential])).digest('hex');
    return {id,engine:role.engine,provider:role.provider,locationId:location.id,nativeConsole:native&&role.engine==='antigravity'&&location.type==='local',refreshable:Boolean(refreshable),managed,guide:guides[native?role.engine:role.provider]||''};
  }
  endpoint(role){
    const defaults={deepseek:'https://api.deepseek.com',moonshot:'https://api.moonshot.cn/v1'};if(!defaults[role.provider])return null;
    try{const url=new URL(role.baseUrl||defaults[role.provider]);if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.search||url.hash)return null;
      if(role.provider==='deepseek'&&url.hostname==='api.deepseek.com'&&['','/','/v1','/v1/'].includes(url.pathname))return 'https://api.deepseek.com/user/balance';
      if(role.provider==='moonshot'&&['api.moonshot.cn','api.moonshot.ai'].includes(url.hostname)&&['/v1','/v1/'].includes(url.pathname))return url.origin+'/v1/users/me/balance';
    }catch{}return null;
  }
  snapshot(){
    const groups=new Map();for(const role of this.store.state.roles){const d=this.descriptor(role);if(groups.has(d.id)){groups.get(d.id).roleIds.push(role.id);continue;}
      let value=this.cache[d.id];if(d.managed&&!this.versions.has(d.id)){const shared=this.backend.usage[role.engine];if(shared?.windows?.length&&(!value?.updatedAt||shared.updatedAt>value.updatedAt))value=normalize(shared);}
      value||=normalize({state:d.refreshable?'pending':'unsupported',reason:d.refreshable?'not_loaded':role.provider==='native'?'manual_only':this.endpoint(role)?'api_console':role.baseUrl&&['deepseek','moonshot'].includes(role.provider)?'custom_endpoint':'api_console'});
      groups.set(d.id,{...d,roleIds:[role.id],...value,cached:value.cached||Boolean(value.updatedAt&&Date.now()-value.updatedAt>300000),loading:this.pending.has(d.id)});
    }return [...groups.values()];
  }
  async request(roleId){
    if(!roleId){const seen=new Set();for(const role of [...this.store.state.roles]){const d=this.descriptor(role);if(!d.refreshable||seen.has(d.id))continue;seen.add(d.id);await this.request(role.id);}return this.snapshot();}
    const role=structuredClone(this.store.get('roles',roleId)),d=this.descriptor(role);
    if(!d.refreshable)return this.snapshot();if(this.pending.has(d.id))return this.pending.get(d.id);
    const cooldown=d.managed?300000:60000;if(Date.now()-(this.attempts.get(d.id)||0)<cooldown)return this.snapshot();this.attempts.set(d.id,Date.now());
    const version=this.versions.get(d.id)||0;
    const task=(async()=>{
      try{let result;
        if(d.managed){await this.locations.connect(role.locationId);await this.backend.refreshUsage(role.engine,true);result=this.backend.usage[role.engine];}
        else if(role.provider!=='native')result=await this.balance(role);
        else{const cwd=path.join(this.store.directory,'usage-cwd');fs.mkdirSync(cwd,{recursive:true});let env=this.agents.environment(role);for(const folder of [env.CODEX_HOME,env.CLAUDE_CONFIG_DIR])if(folder&&!(usesDesktopLogin(role)&&folder===env.CODEX_HOME))fs.mkdirSync(folder,{recursive:true});env=await this.network.environmentFor(role,env);result=await this.native(role,env,cwd,{children:this.children});}
        if((this.versions.get(d.id)||0)!==version)return this.snapshot();
        result=normalize(result);const previous=this.cache[d.id];this.cache[d.id]=result.state==='error'&&previous?{...previous,cached:true,state:'error',reason:result.reason||'query_failed'}:result;
      }catch{if((this.versions.get(d.id)||0)===version){const previous=this.cache[d.id];this.cache[d.id]=normalize({...previous,state:'error',reason:'query_failed',cached:Boolean(previous?.updatedAt)});}}
      finally{this.pending.delete(d.id);const entries=Object.entries(this.cache).slice(-100);this.cache=Object.fromEntries(entries);atomic(this.file,this.cache);this.emit();}
      return this.snapshot();
    })();this.pending.set(d.id,task);this.emit();return task;
  }
  async balance(role){
    const key=this.vault.get('api:'+role.id);if(!key)return {state:'not_signed_in',reason:'auth_required'};
    const response=await (await this.network.fetchFor(role))(this.endpoint(role),{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(20000)});
    if([401,403].includes(response.status))return {state:'not_signed_in',reason:'auth_required'};if(!response.ok)throw new Error('Balance request failed.');
    const text=await response.text();if(text.length>65536)throw new Error('Balance response limit exceeded.');const data=JSON.parse(text);let balances;
    if(role.provider==='deepseek')balances=(data.balance_infos||[]).map(b=>({currency:b.currency,remaining:b.total_balance}));
    else{if(data.code!==0||!data.data)throw new Error('Balance data unavailable.');balances=[{currency:new URL(this.endpoint(role)).hostname.endsWith('.cn')?'CNY':'USD',remaining:String(data.data.available_balance)}];}
    const result=normalize({state:'ready',balances,updatedAt:Date.now(),source:role.provider+'-api'});if(!result.balances.length)throw new Error('Balance data unavailable.');return result;
  }
  guide(roleId){const role=this.store.get('roles',roleId);return this.descriptor(role).guide;}
  invalidate(roleId){const d=this.descriptor(this.store.get('roles',roleId));delete this.cache[d.id];this.attempts.delete(d.id);this.versions.set(d.id,(this.versions.get(d.id)||0)+1);atomic(this.file,this.cache);this.emit();}
  close(){for(const child of this.children)child.kill();this.children.clear();}
}
module.exports={Usage,normalize,codexUsage,claudeUsage,queryNative};
