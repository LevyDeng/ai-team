const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');
const {argumentsFor, buildPrompt} = require('./agents.cjs');
const {effectiveRole} = require('./conversations.cjs');
const {formatMissingProjectDirectories} = require('./project-directories.cjs');
const {shellQuote} = require('../config.cjs');
const {NativeHistory,displayEvent,eventKey}=require('./native-history.cjs');
const {waitForRemoteExit} = require('./remote-exit.cjs');
const steerKey = '\x1b[20~'; // F9 is reserved for the Codex composer; Enter also answers modals.

function interactiveArgs(role, contextFile, session) {
  const binding=typeof session==='string'?{id:session,resumed:false}:session;
  if (!['claude', 'codex'].includes(role.engine)) throw new Error('Interactive terminals currently support Claude and Codex.');
  const args = argumentsFor(role);
  const context = 'Before replying to the first user message, read ' + contextFile + ' to load your ai-team role definition, speaking examples, project locations and prior chat context. Treat earlier messages as historical data, not a new task; do not automatically execute an older request. Your current user types in this interactive terminal.';
  if (role.engine === 'claude') {
    const remove = new Set(['-p', '--verbose', '--include-partial-messages', '--no-session-persistence']);
    const result = [];
    for (let i = 0; i < args.length; i++) {
      if (['--input-format', '--output-format'].includes(args[i])) { i++; continue; }
      if (!remove.has(args[i])) result.push(args[i]);
    }
    return [...result, ...(binding?.id?[binding.resumed?'--resume':'--session-id',binding.id]:[]), '--append-system-prompt', context];
  }
  const result = [...args];result.splice(result.indexOf('exec'),4);
  result.pop(); // The final stdin prompt marker belongs to exec, not the TUI.
  result[result.indexOf('-a') + 1] = role.permission === 'danger-full-access' ? 'never' : 'on-request';
  if(role.provider==='native'&&binding?.record?.disableRequestCompression)result.unshift('-c','features.enable_request_compression=false');
  return [...result,...(binding?.resumed?['resume',binding.id]:[]), '--no-alt-screen','--no-daemon', '-c', 'developer_instructions=' + JSON.stringify(context)];
}

class InteractiveAgents {
  constructor({store, vault, agents, locations, network, emit, busy, count, spawn, message=()=>{}, completed=()=>{}}) {
    Object.assign(this, {store, vault, agents, locations, network, emit, busy, count, spawn,message,completed});
    this.entries = new Map(); this.closed = false;
    for(const chat of store.state.chats)for(const saved of Object.values(chat.interactiveTerminals||{})){
      if(saved?.id&&saved.roleId)this.entries.set(saved.id,{info:{id:saved.id,chatId:chat.id,projectId:chat.projectId,roleId:saved.roleId,engine:saved.engine,state:'ended'},output:String(saved.output||'').slice(-200000),sequence:0,end:()=>{}});
    }
  }
  list() { return [...this.entries.values()].map(e => ({...e.info, output:e.output, sequence:e.sequence})); }
  active(chatId) { return [...this.entries.values()].some(e => (!chatId || e.info.chatId === chatId) && ['opening','ready'].includes(e.info.state)); }
  async open(chatId, roleId) {
    if (this.closed) throw new Error('ai-team is closing.');
    const chat = this.store.get('chats', chatId), project = this.store.get('projects', chat.projectId);
    if (!chat.roleIds.includes(roleId)) throw new Error('Choose a participant in this chat.');
    const existing = [...this.entries.values()].find(e => e.info.chatId === chatId && e.info.roleId === roleId && e.info.state !== 'ended');
    if (existing) return existing.info.id;
    if (this.busy(chatId)) throw new Error('Wait for the current discussion to finish, or pause it before opening an interactive terminal.');
    const active = [...this.entries.values()].filter(e => e.info.state !== 'ended').length;
    if (active + this.count() >= this.store.state.settings.maxJobs) throw new Error('The concurrent agent limit has been reached. End an interactive terminal or pause a discussion.');
    const role = structuredClone(effectiveRole(chat, this.store.get('roles', roleId)));
    if (role.enabled === false) throw new Error('请先启用此角色，再打开交互终端。');
    if (!['claude','codex'].includes(role.engine)) throw new Error('Interactive terminals currently support Claude and Codex.');
    const location = this.store.get('locations', role.locationId), directory = project.directories.find(d => d.locationId === role.locationId);
    if (!directory) throw new Error(formatMissingProjectDirectories(project, [role], () => location.name || location.id));
    if (location.type !== 'local' && (location.os !== 'linux' || role.provider !== 'native')) throw new Error('Remote interactive terminals require a native Claude or Codex role on Linux.');
    const id = crypto.randomUUID(), home = path.join(this.store.directory, 'interactive', id);
    let executable='';if(location.type==='local')try{executable=require('./agents.cjs').findExecutable(role);}catch{}
    const nativeSession=require('./native-sessions.cjs').plan({store:this.store,chatId,role,project,location,directory,executable,desktopHome:role.codexLoginSource==='desktop'?this.agents.desktopHome?.()||'':'',env:location.type==='local'&&this.agents.environment?this.agents.environment(role):{},apiKey:role.provider!=='native'?this.vault.get('api:'+role.id)||'':''});
    if(role.engine==='claude'&&!nativeSession.resumed&&!nativeSession.record.confirmed){nativeSession.record.id=id;this.store.save();}
    const context = buildPrompt(role, project, nativeSession.context({...chat, discussion:undefined}))+'\n\n'+nativeSession.instructions();
    fs.mkdirSync(home, {recursive:true});
    const contextFile = path.join(home, 'context.txt');
    fs.writeFileSync(contextFile, context, {mode:0o600});
    const entry = {info:{id,chatId,projectId:project.id,roleId,state:'opening',engine:role.engine,taskState:'unknown',inputReady:false,nativeSessionId:nativeSession.id},nativeSession,role,output:'',sequence:0,home,secrets:[],transport:null,records:new Set(),logical:[],turn:0};
    entry.skillScope=this.agents.skills?.scope(chatId,roleId,'interactive:'+id);
    this.entries.set(id,entry);
    for(const [oldId,old] of this.entries)if(oldId!==id&&old.info.chatId===chatId&&old.info.roleId===roleId&&old.info.state==='ended')this.entries.delete(oldId);
    const save = () => {chat.interactiveTerminals||={};chat.interactiveTerminals[roleId]={id,roleId,engine:role.engine,output:entry.output};this.store.scheduleSave();};
    const notify = () => this.emit({type:'state',info:{...entry.info}});
    const write = data => {
      if (entry.info.state === 'ended') return;
      // Keep credentials out of the replay and renderer when a runtime echoes configuration.
      let value = (entry.redactionTail||'')+String(data);entry.redactionTail='';
      for (const secret of entry.secrets) if (secret) value = value.split(secret).join('[redacted]');
      let suffix=0;for(const secret of entry.secrets)for(let length=1;length<secret.length&&length<=value.length;length++)if(value.endsWith(secret.slice(0,length)))suffix=Math.max(suffix,length);
      if(suffix){entry.redactionTail=value.slice(-suffix);value=value.slice(0,-suffix);}
      if(!value)return;
      entry.output = (entry.output + value).slice(-200000);
      save();
      this.emit({type:'data',id,sequence:++entry.sequence,data:value});
    };
    entry.end = error => {
      if (entry.info.state === 'ended'||entry.ending) return;entry.ending=true;
      clearInterval(entry.historyTimer);entry.reader?.poll();
      error||=entry.nativeSessionError;
      if(entry.skillScope)this.agents.skills.closeTask(entry.skillScope.taskId);entry.skillBridge?.close();
      for(const pending of entry.pending||[])if(pending.message.status==='submitting'){pending.message.status='unconfirmed';pending.message.note='CLI submission was not confirmed. Restore this message to retry.';this.message({chatId,message:pending.message});}
      for(const item of entry.logical)if(item.message.kind==='assistant'&&item.message.status==='running'){item.message.status='interrupted';this.message({chatId,message:item.message});}
      entry.nativeSession.endInteractive(entry.info.taskState);
      if (error) write('\r\n' + String(error.message).replace(/[\x00-\x1f\x7f]/g,' ') + '\r\n');
      write('\r\n[Interactive terminal ended]\r\n');
      entry.info.state = 'ended'; entry.transport = null;
      entry.prepared?.bridge?.close(); entry.prepared?.tools?.close();
      fs.rmSync(home,{recursive:true,force:true}); save();notify();
    };
    notify();
    try {
      if (location.type === 'local') {
        const prepared = entry.prepared = await this.agents.prepareLocal(role,home,project,entry.skillScope,undefined,nativeSession);
        if (role.engine === 'codex') {
          const version = require('./codex-diagnostics.cjs').version(prepared.executable);
          const [major, minor] = version.split('.').map(Number);
          entry.canSteer = major > 0 || major === 0 && minor >= 170;
        }
        entry.secrets = Object.entries(prepared.env).filter(([key]) => /TOKEN|SECRET|API_KEY/.test(key)).map(([,value]) => value);
        if(role.provider!=='native')entry.secrets.push(this.vault.get('api:'+role.id));
        if (entry.info.state === 'ended' || this.closed) { prepared.bridge?.close(); prepared.tools?.close();fs.rmSync(home,{recursive:true,force:true}); throw new Error('Interactive terminal was closed during startup.'); }
        const args = [...interactiveArgs(role,contextFile,nativeSession), ...prepared.extra];
        if(entry.canSteer)args.unshift('-c','tui.keymap.composer.submit=["enter","f9"]');
        if(role.engine==='codex')prepared.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE='relay_desk_'+id.replaceAll('-','');
        if (process.platform === 'win32' && role.engine === 'codex' && role.permission === 'workspace-write') args.unshift('-c','features.prefer_mxc=true','-c','windows.sandbox="unelevated"');
        if (/\.cmd$/i.test(prepared.executable)) throw new Error('Choose a native agent executable instead of a command shim.');
        entry.reader=new NativeHistory({root:role.engine==='claude'?prepared.env.CLAUDE_CONFIG_DIR:prepared.env.CODEX_HOME,engine:role.engine,session:nativeSession.id,originator:prepared.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,start:nativeSession.resumed?nativeSession.record.createdAt:Date.now(),fromEnd:nativeSession.resumed,exactSession:nativeSession.resumed,event:(row,record)=>this.sync(entry,row,record)});if(nativeSession.resumed)entry.reader.poll();
        const pty = this.spawn(prepared.executable,args,{cwd:directory.path,env:prepared.env,name:'xterm-256color',cols:100,rows:30,useConptyDll:true});
        entry.transport = {write:data=>pty.write(data),resize:(cols,rows)=>pty.resize(cols,rows),close:()=>pty.kill(),
          force:()=>new Promise(resolve=>{
            if(process.platform==='win32'){
              if(!Number.isSafeInteger(pty.pid)||pty.pid<1)return resolve(false);
              execFile('taskkill.exe',['/PID',String(pty.pid),'/T','/F'],{windowsHide:true,timeout:8000},error=>resolve(!error));
            }else{pty.kill('SIGKILL');entry.exited.then(()=>resolve(true));}
          })};
        pty.onData(write);
        entry.exited = new Promise(resolve => pty.onExit(() => { resolve(); entry.end(); }));
        entry.historyTimer=setInterval(()=>entry.reader.poll(),500);entry.historyTimer.unref();
      } else {
        if (location.managed) {
          const memory=Number((await this.locations.exec(location.id,"awk '/MemAvailable:/ {print $2}' /proc/meminfo")).trim());
          if (!Number.isFinite(memory)||memory<700*1024) throw new Error('The server has less than 700 MiB available. End an idle agent first.');
        }
        const remote = await this.locations.runner(location.id, directory.path);
        if (entry.info.state === 'ended' || this.closed) throw new Error('Interactive terminal was closed during startup.');
        const mcpTargets = role.allowLocationTools === false ? [] : project.directories.map(d=>this.store.get('locations',d.locationId)).filter(l=>l.control==='windows-mcp').map(l=>({url:l.mcpUrl,token:this.vault.get('mcp:'+l.id)}));
        if (role.allowLocationTools !== false && !location.managed && location.os === 'linux' && this.agents?.mcpTunnels) {
          const tunnelTarget = await this.agents.mcpTunnels.ensureForAgent(location.id);
          if (tunnelTarget) mcpTargets.push(tunnelTarget);
        }
        if(entry.skillScope){const local=await require('./mcp-tools.cjs').createTools({...project,directories:[]},this.store,this.locations,{service:this.agents.skills,scope:entry.skillScope});if(local){try{entry.skillBridge=await require('../reverse-routes.cjs').expose(remote.client,local);}catch(error){local.close();throw error;}mcpTargets.push({url:entry.skillBridge.url,token:entry.skillBridge.token});}}
        if(entry.info.state==='ended'||this.closed){entry.skillBridge?.close();throw new Error('Interactive terminal was closed during startup.');}
        const stream = await new Promise((resolve,reject)=>remote.client.exec('python3 '+shellQuote(remote.file),(error,value)=>error?reject(error):resolve(value)));
        if (entry.info.state === 'ended' || this.closed) { stream.close(); throw new Error('Interactive terminal was closed during startup.'); }
        const decoder = new StringDecoder('utf8');
        stream.on('data',data=>write(decoder.write(data)));
        let control='';const controlDecoder=new StringDecoder('utf8');stream.stderr.on('data',data=>{
          control+=controlDecoder.write(data);if(control.length>2*1024*1024){control='';return;}
          let split;while((split=control.indexOf('\n'))>=0){const line=control.slice(0,split);control=control.slice(split+1);try{const frame=JSON.parse(line);if(frame.type==='relay-history'){this.sync(entry,frame.row,frame.record);continue;}}catch{}write(line+'\r\n');}
        });
        stream.on('error',error=>entry.end(error));stream.on('close',()=>{write(decoder.end());entry.end();});
        entry.exited = new Promise(resolve => {
          stream.once('close', resolve);
          stream.once('error', resolve);
        });
        const send = value => stream.write(JSON.stringify(value)+'\n');
        entry.transport = {write:data=>send({type:'input',data}),resize:(cols,rows)=>send({type:'resize',cols,rows}),close:()=>{send({type:'close'});setTimeout(()=>stream.close(),5500).unref();},
          force:async()=>{
            const result=waitForRemoteExit(stream,undefined,{signal:AbortSignal.abort()}).then(()=>true,error=>error.exitCode===130);
            try{send({type:'force-close'});}catch{stream.close();}
            return result;
          }};
        entry.secrets = mcpTargets.map(t=>t.token).filter(Boolean);
        stream.write(JSON.stringify({interactive:true,syncHistory:true,nativeSessionId:nativeSession.id,nativeSessionStart:nativeSession.record.createdAt,resuming:nativeSession.resumed,cwd:directory.path,command:[role.executable||role.engine,...interactiveArgs(role,'__RELAY_CONTEXT__',nativeSession)],context,input:'',jobId:id,roleId:role.id,engine:role.engine,managed:Boolean(location.managed),mcpTargets,proxy:this.network?.policy(role)||{mode:'system',url:''}})+'\n');
      }
      if (entry.info.state !== 'ended') { entry.info.state='ready';notify(); }
      return id;
    } catch(error) { entry.transport?.close();entry.end(error);throw error; }
  }
  sync(entry,row,record){
    if(entry.info.state==='ended')return;
    const sessionId=entry.role.engine==='codex'&&row.type==='session_meta'?row.payload?.id:entry.role.engine==='claude'?(row.sessionId||entry.nativeSession.id):'';
    if(sessionId&&entry.info.nativeSessionId!==sessionId||sessionId&&!entry.nativeSession.record.confirmed){try{entry.nativeSession.identify(sessionId);entry.info.nativeSessionId=sessionId;}catch(error){entry.nativeSessionError=error;entry.transport?.close();entry.end(error);return;}}
    const fingerprint=String(record)+':'+eventKey(JSON.stringify(row));if(entry.records.has(fingerprint))return;
    const event=displayEvent(entry.role.engine,row);if(!event)return;
    if(entry.canSteer&&row.type==='event_msg'){
      if(row.payload?.type==='task_started')entry.nativeTurnRunning=true;
      else if(['task_complete','turn_aborted','error'].includes(row.payload?.type))entry.nativeTurnRunning=false;
    }
    if(event.kind&&event.text?.trim()){
      let text=event.text;for(const secret of entry.secrets)if(secret)text=text.split(secret).join('[redacted]');
      let item=event.key?entry.logical.find(item=>item.key===event.key&&item.message.kind===event.kind):null;
      // Codex writes the same public message in both event and response representations.
      if(!item&&entry.role.engine==='codex')item=[...entry.logical].reverse().find(item=>item.turn===entry.turn&&item.message.kind===event.kind&&(item.wireText||item.message.text)===text&&item.family!==event.family);
      if(!item){
        let pending;if(event.kind==='user'){const normalize=s=>s.replace(/\r\n?/g,'\n').trimEnd();pending=(entry.pending||[]).find(p=>!p.confirmed&&normalize(p.wireText)===normalize(text));if(pending)pending.confirmed=true;if(!pending?.steer)entry.turn++;}
        if(event.kind==='user'&&entry.skillScope&&!pending?.steer)entry.skillScope.taskId=pending?.message.id||'native:'+entry.info.id+':'+entry.turn;
        const message=pending?.message||this.store.message(entry.info.chatId,{kind:event.kind,text,at:event.at||Date.now(),roleId:entry.role.id,roleName:entry.role.name,locationId:entry.role.locationId,model:event.model||entry.role.model,status:event.kind==='user'?'accepted':'running',nativeTerminalId:entry.info.id});
        message.status=event.kind==='user'?'accepted':event.state==='completed'?'complete':'running';
        item={message,key:event.key,family:event.family,turn:entry.turn,wireText:text};entry.logical.push(item);
      }else if(item.message.text!==text){item.message.text=text;}
      if(event.model)item.message.model=event.model;
      if(event.kind==='assistant')item.message.status=event.state==='completed'?'complete':'running';
      if(event.kind==='user')entry.nativeSession.submit();entry.nativeSession.observe(item.message);item.message.nativeSession={...entry.nativeSession.info(),mode:entry.turn>1?'resumed':entry.nativeSession.info().mode};
      this.message({chatId:entry.info.chatId,message:item.message});
    }
    if(event.state){
      const previous=entry.info.taskState;entry.info.taskState=event.state;
      if(entry.screenText)this.screen(entry.info.id,entry.screenText);
      if(['completed','interrupted','failed'].includes(event.state))for(const item of entry.logical)if(item.message.kind==='assistant'&&item.message.status==='running'){item.message.status=event.state==='completed'?'complete':event.state==='failed'?'failed':'interrupted';this.message({chatId:entry.info.chatId,message:item.message});}
      if(event.state==='completed')entry.nativeSession.endInteractive('completed');this.store.scheduleSave();this.emit({type:'state',info:{...entry.info}});
      if(event.state==='completed'&&previous!=='completed'&&entry.logical.some(item=>item.message.kind==='assistant'&&item.turn===entry.turn))this.completed(entry.info.chatId);
    }
    entry.records.add(fingerprint);
  }
  screen(id,text){
    const entry=this.entries.get(id);if(!entry||typeof text!=='string'||text.length>30000)return;
    entry.screenText=text;
    const lines = (entry.role.engine === 'codex' ? text.trimEnd().split('\n').slice(-8) : text.split('\n'));
    const prompt = lines.some(line => /^[ \t]*[❯›>][ \t]*[\u2588\u258f]?[ \t]*$/.test(line) ||
      (entry.role.engine === 'codex' && /^[ \t]*[❯›][ \t]+Ask Codex to do anything[ \t]*$/.test(line)));
    const blocked=/trust (?:this|the) (?:folder|directory)|Do you trust|terms of (?:service|use)|Enter to confirm|Allow (?:once|this)|requires? (?:your )?approval|permission (?:prompt|request)/i.test(text);
    const idle=prompt&&!blocked&&['unknown','completed','interrupted','failed'].includes(entry.info.taskState);
    const steerReady=Boolean(entry.nativeTurnRunning&&prompt&&!blocked&&entry.info.taskState==='running');
    if(entry.info.inputReady!==idle||Boolean(entry.info.steerReady)!==steerReady){
      entry.info.inputReady=idle;entry.info.steerReady=steerReady;this.emit({type:'state',info:{...entry.info}});
    }
  }
  submit(chatId,roleId,{text,wireText=text,attachments=[],settings,inputQueueId,steer=false}){
    const entry=[...this.entries.values()].find(e=>e.info.chatId===chatId&&e.info.roleId===roleId&&e.info.state==='ready');
    if(!entry)throw new Error('The interactive terminal is not connected.');
    if(settings&&((settings.model||'')!==(entry.role.model||'')||(settings.effort||'')!==(entry.role.effort||'')))throw new Error('模型或推理设置已改变。请重新建立交互连接以应用新设置，或直接在终端使用原生命令修改；当前输入已保留。');
    if (!steer && settings && ['persona', 'examples'].some(key => Object.hasOwn(settings, key) && (settings[key] || '') !== (entry.role[key] || ''))) {
      throw new Error('本对话人设已更改。请重新建立交互连接以应用新设定，当前输入已保留。');
    }
    if(steer){
      if(!entry.info.steerReady||entry.info.taskState!=='running')throw new Error('Codex 当前没有可以插话的任务，输入内容已保留。');
      if(attachments.length)throw new Error('插话仅支持文字，附件已保留。');
    }else if(!entry.info.inputReady||['running','waiting'].includes(entry.info.taskState))throw new Error('终端尚未就绪、正在运行或等待确认。请先在交互终端完成操作，输入内容已保留。');
    if(typeof wireText!=='string'||wireText.length>100000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(wireText))throw new Error('Invalid interactive message.');
    if(/^\s*\//.test(wireText)||steer&&/^\s*!/.test(wireText))throw new Error('原生命令请直接在交互终端输入。');
    const message=this.store.message(chatId,{kind:'user',text,attachments,status:'submitting',nativeTerminalId:entry.info.id,inputQueueId});
    if(entry.skillScope&&!steer)entry.skillScope.taskId=message.id;
    entry.pending||=[];entry.pending.push({message,wireText,steer,confirmed:false});this.message({chatId,message});
    try{if(!steer)entry.nativeSession.submit();entry.transport.write('\x1b[200~'+wireText+'\x1b[201~');entry.transport.write(steer?steerKey:'\r');entry.info.inputReady=false;entry.info.steerReady=false;entry.info.taskState='running';this.emit({type:'state',info:{...entry.info}});}catch(error){message.status='unconfirmed';this.store.save();this.message({chatId,message});throw error;}
    return {accepted:true,messageId:message.id};
  }
  interrupt(chatId) {
    const entry = [...this.entries.values()].find(({info}) => info.chatId===chatId && info.state==='ready' && ['running','waiting'].includes(info.taskState));
    if (!entry) return false;
    this.input(entry.info.id, '\x1b');
    return true;
  }
  async forceStop(id) {
    const entry=this.entries.get(id);
    if(!entry||entry.info.state==='ended'||entry.info.forceStopping)return;
    entry.info.forceStopping=true;
    this.emit({type:'state',info:{...entry.info}});
    try {
      if(!entry.transport||await entry.transport.force())entry.end();
      else throw new Error('无法确认交互终端已强制结束。请检查任务输出。');
    } finally {
      entry.info.forceStopping=false;
      this.emit({type:'state',info:{...entry.info}});
    }
  }
  input(id,data) { if(typeof data!=='string'||data.length>100000)throw new Error('Invalid terminal input.');const e=this.entries.get(id);if(e?.info.state!=='ready')throw new Error('The interactive terminal is not connected.');if(e.info.inputReady||e.info.steerReady){e.info.inputReady=false;e.info.steerReady=false;this.emit({type:'state',info:{...e.info}});}e.transport.write(data); }
  resize(id,cols,rows) { if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>500||rows<2||rows>300)return;this.entries.get(id)?.transport?.resize(cols,rows); }
  close(id) { const e=this.entries.get(id);if(e){e.transport?.close();e.end();} }
  closeAll() {
    this.closed = true;
    const exits = [...this.entries.values()].map(entry => entry.exited).filter(Boolean);
    for (const id of this.entries.keys()) this.close(id);
    return Promise.all(exits);
  }
}
module.exports={InteractiveAgents,interactiveArgs};
