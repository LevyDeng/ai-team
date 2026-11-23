const { StringDecoder } = require('node:string_decoder');
const { addAbortListener } = require('node:events');
const { terminal } = require('./activity.cjs');
const { parseCursorModel, formatCursorModel } = require('./chat-settings.js');
function requestTimeout(engine,method){return engine==='antigravity'?(method==='initialize'?60000:['session/new','session/load','session/resume'].includes(method)?120000:20000):20000;}

const maxBackgroundContinuations = 3;
const backgroundContinuation = [
  'Continue the same workflow step. The background commands from your previous turn have now exited.',
  'Check their actual exit results and logs in this session. Reuse the completed work and do not relaunch a command just to wait for it.',
  'Wait for any further required validation to finish before reporting the result. Respond in the user language and use the same final response format as the original workflow step.',
].join(' ');

class AcpClient {
  constructor(child, state, update, role) {
    Object.assign(this,{child,state,update,role});this.pending=new Map();this.nextId=1;this.buffer='';this.decoder=new StringDecoder('utf8');
    child.stdout.on('data',chunk=>this.consume(chunk));
    child.once('error',()=>this.close(new Error('Could not start the official agent runtime.')));
    child.once('exit',code=>this.close(new Error('Agent protocol closed before completion (exit '+code+'). Check its official login and runtime.')));
    child.stdin.on('error',()=>{});
  }
  send(message) { this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n'); }
  call(method,params,timeout=requestTimeout(this.role.engine,method)) {
    if(this.closed)return Promise.reject(new Error('Agent connection is closed.'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{const timer=timeout?setTimeout(()=>{this.pending.delete(id);const error=new Error('Agent protocol request timed out: '+method+' after '+Math.ceil(timeout/1000)+' seconds. The chat task has not been automatically retried.');error.code='VENDOR_PROTOCOL_TIMEOUT';error.method=method;error.timeoutMs=timeout;reject(error);},timeout):null;this.pending.set(id,{method,resolve,reject,timer});try{this.send({id,method,params});}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}});
  }
  consume(chunk) {
    this.buffer+=this.decoder.write(chunk);
    if(this.buffer.length>8*1024*1024){this.close(new Error('Agent protocol event exceeded its size limit.'));return;}
    let index;
    while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;let message;try{message=JSON.parse(line);}catch{continue;}
      if(message.method){try{this.notification(message);}catch{this.close(new Error('The agent returned an invalid protocol update.'));}continue;}
      const request=this.pending.get(message.id);if(!request)continue;this.pending.delete(message.id);clearTimeout(request.timer);
      if(message.error){const error=new Error('Official agent rejected '+(message.error.message || 'the request')+'. Complete its account login or check the model ID.');error.rpcCode=message.error.code;if(message.error.code===-32000 && /auth|login/i.test(message.error.message || '') || /authentication required|not authenticated|not logged in/i.test(message.error.message || ''))error.code='VENDOR_LOGIN_REQUIRED';request.reject(error);}
      else {
        // Capture this before processing any subsequent tool events in the same chunk.
        if(request.method==='session/prompt')this.backgroundAtTurnEnd=Boolean(this.backgroundCommands?.size);
        request.resolve(message.result);
      }
    }
  }
  notification(message) {
    if(['cursor/ask_question','cursor/create_plan'].includes(message.method)&&message.id!==undefined){this.send({id:message.id,result:{outcome:{outcome:'cancelled'}}});this.state.note='The agent requested an interactive question or plan approval. Reply in chat with your decision; this request was not auto-approved.';this.update();return;}
    if(message.method==='session/request_permission' && message.id!==undefined){
      const selected=this.role.permission==='danger-full-access'?(message.params?.options || []).find(option=>option.kind==='allow_once'):null;
      this.send({id:message.id,result:{outcome:selected?{outcome:'selected',optionId:selected.optionId}:{outcome:'cancelled'}}});
      if(!selected){this.state.note='A tool requested additional permission and was not approved. Use the role permission setting or the official agent interface to approve it.';this.update();}return;
    }
    if(message.method==='session/update') {
      if(this.replaying)return;
      const item=message.params?.update || {},kind=item.sessionUpdate;
      if(kind==='agent_message_chunk' && item.content?.type==='text'){this.state.text+=item.content.text || '';terminal(this.state,item.content.text || '');}
      else if(kind==='agent_thought_chunk' && item.content?.type==='text'){this.state.thinking=((this.state.thinking || '')+(item.content.text || '')).slice(-65536);}
      else if(kind==='tool_call' || kind==='tool_call_update'){
        if(!message.params.sessionId || message.params.sessionId===this.sessionId)this.trackBackgroundCommand(item);
        this.state.activities ||= [];let tool=this.state.activities.find(tool=>tool.id===item.toolCallId);
        if(!tool){tool={id:item.toolCallId,title:item.title || item.kind || 'Tool',status:'running'};this.state.activities.push(tool);}
        if(item.title)tool.title=item.title;if(item.status)tool.status=({pending:'running',in_progress:'running',completed:'complete',failed:'failed'})[item.status] || item.status;
        this.state.activities=this.state.activities.slice(-80);
        const output=(Array.isArray(item.content)?item.content:[]).filter(block=>block.type==='content' && block.content?.type==='text').map(block=>block.content.text).join('\n');
        terminal(this.state,'\r\n['+tool.title+' · '+tool.status+']\r\n'+output.slice(-32000)+'\r\n');
      }
      this.update();return;
    }
    if(message.id!==undefined)this.send({id:message.id,error:{code:-32601,message:'ai-team does not provide this client operation.'}});
  }
  async initialize() {
    const clientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
    if (this.role.engine === 'cursor') clientCapabilities._meta = { parameterizedModelPicker: true };
    const result=await this.call('initialize',{protocolVersion:1,clientInfo:{name:'ai-team',title:'ai-team',version:'0.1.0'},clientCapabilities});
    if(result?.protocolVersion!==1)throw new Error('The agent uses an unsupported ACP protocol version.');
    this.capabilities=result.agentCapabilities || {};return result;
  }
  async session(cwd,mcp,previous) {
    const servers=[];
    for(const [name,value] of Object.entries(mcp || {})){
      if(value.command)servers.push({name,command:value.command,args:value.args || [],env:Object.entries(value.env || {}).map(([name,value])=>({name,value}))});
      else if(this.capabilities.mcpCapabilities?.http)servers.push({type:'http',name,url:value.url,headers:Object.entries(value.headers || {}).map(([name,value])=>({name,value}))});
      else throw new Error('This agent cannot load project HTTP MCP endpoints through ACP. Disable project location tools or use a supported agent.');
    }
    let method='session/new',restored=false,fallback='';
    if(previous?.id){if(this.capabilities.sessionCapabilities?.resume)method='session/resume';else if(this.capabilities.loadSession)method='session/load';else fallback='resume_unsupported';}
    let result;try{this.replaying=method==='session/load';result=await this.call(method,{cwd,mcpServers:servers,...(method!=='session/new'?{sessionId:previous.id}:{})});restored=method!=='session/new';}
    catch(error){if(method==='session/new'||error.rpcCode!==-32002)throw error;fallback='session_missing';result=await this.call('session/new',{cwd,mcpServers:servers});}
    finally{this.replaying=false;}
    const sessionId=result?.sessionId||(restored?previous.id:'');if(!sessionId)throw new Error('The agent did not create a session.');if(restored&&sessionId!==previous.id){const error=new Error('The agent returned a different session while resuming.');error.code='NATIVE_SESSION_MISMATCH';throw error;}this.sessionId=sessionId;return {...(restored?previous.metadata||{}:{}),...result,sessionId,restored,fallback};
  }
  async configure(session) {
    if (this.role.engine === 'cursor') return this.configureCursor(session);
    const strict=this.role.engine==='antigravity';if(!strict&&!session.restored)return;
    let options=session.configOptions || [];
    const select=async(option,value)=>{
      const choices=(option.options || []).flatMap(item=>item.options || [item]);
      if(!choices.some(choice=>choice.value===value))throw new Error('The account does not offer the selected '+option.id+' value. Refresh the model/settings list.');
      const result=await this.call('session/set_config_option',{sessionId:this.sessionId,configId:option.id,value});if(result?.configOptions)options=result.configOptions;
    };
    if(this.role.model){const model=options.find(option=>option.category==='model'||option.id==='model');const choices=(model?.options || []).flatMap(item=>item.options || [item]);if(model&&choices.some(choice=>choice.value===this.role.model))await select(model,this.role.model);else if(session.models?.availableModels?.some(model=>model.modelId===this.role.model)){const result=await this.call('session/set_model',{sessionId:this.sessionId,modelId:this.role.model});if(result?.configOptions)options=result.configOptions;}else if(strict||session.previousSettings?.model!==this.role.model)throw new Error(strict?'Antigravity did not offer the selected model to this client. Refresh the model list.':'This agent cannot apply the changed model to its restored session. Reset this role native session to use the new setting.');}
    if(this.role.effort){const effort=options.find(option=>option.category==='thought_level'||/effort|thinking|thought/i.test(option.id));if(!effort){if(strict||session.previousSettings?.effort!==this.role.effort)throw new Error('This agent does not expose thinking level for restored sessions. Clear the effort selection or reset this role native session.');}else await select(effort,this.role.effort);}
    if(this.role.permission==='read-only'&&strict){
      const mode=session.modes?.availableModes?.find(mode=>['plan','ask','read-only'].includes(mode.id));
      if(mode)await this.call('session/set_mode',{sessionId:this.sessionId,modeId:mode.id});
      else {const option=options.find(option=>option.category==='mode'||option.id==='mode');const choices=(option?.options||[]).flatMap(item=>item.options||[item]);const choice=choices.find(item=>['plan','ask','read-only'].includes(item.value));if(!choice)throw new Error('Antigravity cannot enforce a read-only ACP mode here. Select standard agent permissions or use its supported native mode.');await select(option,choice.value);}
    }
  }
  async configureCursor(session) {
    const requested = parseCursorModel(this.role.model);
    let options = session.configOptions || [];
    const modelOption = options.find(option => option.category === 'model' || option.id === 'model');
    let selected = modelOption?.currentValue || session.models?.currentModelId;
    const matchModel = values => {
      if (values.includes(this.role.model)) return this.role.model;
      const variants = requested.parameters.size ? [] : values.filter(value => parseCursorModel(value).id === requested.id);
      return variants.length === 1 ? variants[0] : undefined;
    };
    if (requested.id && modelOption) {
      const choices = modelOption.options.flatMap(item => item.options || [item]);
      const parameterized = choices.some(choice => choice.value === requested.id);
      const target = parameterized ? requested.id : matchModel(choices.map(choice => choice.value));
      if (!target) {
        throw new Error('Cursor 未提供此模型或变体。请刷新列表并重新选择。');
      }
      const set = async (option, value) => {
        if (!option?.options?.flatMap(choice => choice.options || [choice]).some(choice => choice.value === value)) {
          throw new Error('Cursor 未提供请求的模型参数值（' + value + '）。请刷新模型列表。');
        }
        if (option.currentValue === value) return;
        const result = await this.call('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value });
        options = result?.configOptions || [];
        if (options.find(item => item.id === option.id)?.currentValue !== value) {
          throw new Error('Cursor 未确认应用模型设置（' + option.id + '=' + value + '）。请查看任务输出。');
        }
      };
      await set(modelOption, target);
      if (parameterized) {
        for (const [id, value] of requested.parameters) {
          await set(options.find(option => option.id === id && ['thought_level', 'model_config'].includes(option.category)), value);
        }
        for (const [id, value] of requested.parameters) {
          if (options.find(option => option.id === id)?.currentValue !== value) {
            throw new Error('Cursor 返回的最终模型设置与请求不一致（' + id + '=' + value + '）。');
          }
        }
      }
      selected = target;
    } else if (requested.id && selected !== this.role.model) {
      const target = matchModel((session.models?.availableModels || []).map(model => model.modelId));
      if (!target) {
        throw new Error('Cursor 无法确认此模型。请刷新列表并重新选择。');
      }
      if (selected !== target) await this.call('session/set_model', { sessionId: this.sessionId, modelId: target });
      selected = target;
    }
    if (!selected) return;
    const confirmed = parseCursorModel(selected);
    for (const option of options) {
      if (['thought_level', 'model_config'].includes(option.category) && option.currentValue) {
        confirmed.parameters.set(option.id, option.currentValue);
      }
    }
    this.state.actualModel = confirmed.id;
    terminal(this.state, '\r\n[Cursor confirmed session model] ' + formatCursorModel(confirmed.id, confirmed.parameters) + '\r\n');
    this.update();
  }
  trackBackgroundCommand(item) {
    const commands=this.backgroundCommands;
    if(!commands || !item.toolCallId)return;
    if(['completed','failed','cancelled'].includes(item.status)){
      if(commands.delete(item.toolCallId) && !commands.size)this.backgroundWaiter?.resolve();
    } else if(item.name==='run_command' && item.status==='in_progress' && (item.rawInput || item.args)?.RunPersistent!==true){
      commands.add(item.toolCallId);
    }
  }
  async waitForBackgroundCommands(signal) {
    signal.throwIfAborted();
    if(this.closed)throw this.closeError;
    if(!this.backgroundCommands.size)return;
    const waiter=Promise.withResolvers();
    const abort=addAbortListener(signal,()=>waiter.reject(signal.reason));
    this.backgroundWaiter=waiter;
    try{await waiter.promise;}
    finally{abort[Symbol.dispose]();this.backgroundWaiter=null;}
  }
  async prompt(text, { workflowSignal } = {}) {
    if(this.role.engine==='antigravity' && workflowSignal)this.backgroundCommands=new Set();
    let start=this.state.text.length;
    try{
      let result=await this.promptTurn(text);
      let continuations=0;
      while(result.stopReason==='end_turn' && this.backgroundAtTurnEnd){
        this.state.activity='Waiting for background commands';
        terminal(this.state,'\r\n[Antigravity] Waiting for background command exit results.\r\n');
        this.update();
        try{await this.waitForBackgroundCommands(workflowSignal);}
        catch(error){
          if(workflowSignal.aborted)throw error;
          throw new Error('Antigravity 在后台命令结束前断开，无法确认命令结果。',{cause:error});
        }
        // A new background command can arrive right after a previous one exits.
        if(this.backgroundCommands.size)continue;
        workflowSignal.throwIfAborted();
        if(continuations===maxBackgroundContinuations)throw new Error('后台命令已结束，但 Antigravity 多次续接后仍未确认步骤结果。请查看任务输出后继续。');
        continuations++;
        this.state.activity='Verifying background results';
        terminal(this.state,'\r\n[Antigravity] Verifying background results in the same session.\r\n');
        if(this.state.text)this.state.text+='\n\n';
        start=this.state.text.length;
        this.update();
        result=await this.promptTurn(backgroundContinuation);
      }
      if(continuations && (result.stopReason!=='end_turn' || !this.state.text.slice(start).trim())){
        throw new Error('后台命令已结束，但 Antigravity 未返回验收结果。请查看任务输出后继续。');
      }
      this.state.completed=true;
      this.update();
      return result;
    } finally {
      this.backgroundCommands=null;
    }
  }
  async promptTurn(text) {
    const result=await this.call('session/prompt',{sessionId:this.sessionId,prompt:[{type:'text',text}]},0);
    const meta=result?._meta || {};
    if(meta['codebuddy.ai/errorMessage']||/^FAILED_/.test(meta['codebuddy.ai/outcome'] || '')){
      const raw=meta['codebuddy.ai/errorMessage'];let detail;try{detail=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
      const auth=detail?.data?.category==='auth'||/authentication required|not authenticated|not logged in/i.test(detail?.message || String(raw || ''));
      const error=new Error(auth?'Official agent account authentication is unavailable. The desktop login may require its own credential broker.':'The official agent reported a failed model request. The submitted message and partial output are preserved.');
      if(auth)error.code=this.role.engine==='workbuddy'?'WORKBUDDY_DESKTOP_AUTH_UNAVAILABLE':'VENDOR_LOGIN_REQUIRED';throw error;
    }
    if(!['end_turn','refusal'].includes(result?.stopReason))throw new Error('Agent stopped before completing its turn: '+(result?.stopReason || 'unknown'));
    return result;
  }
  close(error=new Error('Agent protocol closed.')){if(this.closed)return;this.closed=true;this.closeError=error;this.backgroundWaiter?.reject(error);for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();}
}
module.exports={AcpClient,requestTimeout};
