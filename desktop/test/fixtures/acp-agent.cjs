const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const notify=update=>send({method:'session/update',params:{sessionId:'fixture-session',update}});
const input=readline.createInterface({input:process.stdin});
let prompt,servers=[];
let backgroundRemaining=0;
let cursor;
const cursorEffort = { id:'reasoning_effort', category:'thought_level', type:'select', currentValue:'high',
  options:['low','medium','high','xhigh'].map(value => ({value, name:value})) };
const cursorOptions = [
  {id:'model',category:'model',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture model'},{value:'grok-4.7',name:'Grok 4.7'}]},
  cursorEffort,
];
function commandUpdate(id, status, extra = {}) {
  const sessionUpdate = status === 'in_progress' ? 'tool_call' : 'tool_call_update';
  notify({sessionUpdate, toolCallId:id, name:'run_command', status, kind:'execute', ...extra});
}
input.on('line',line=>{
  const message=JSON.parse(line);
  if(message.method==='initialize'){
    cursor=message.params.clientCapabilities?._meta?.parameterizedModelPicker;
    return send({id:message.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:!process.argv.includes('--no-http')}}}});
  }
  if(message.method==='session/new'){servers=message.params.mcpServers;return send({id:message.id,result:{sessionId:'fixture-session',models:{availableModels:[{modelId:'fixture-model',name:'Fixture model'}]},modes:{availableModes:[{id:'plan',name:'Plan'}]},configOptions:cursor ? cursorOptions : [{id:'model',category:'model',options:[{value:'fixture-model',name:'Fixture model'}]},{id:'thought_level',category:'thought_level',options:[{value:'high',name:'High'},{value:'medium',name:'Medium'}]}]}});}
  if(message.method==='cursor/list_available_models')return send({id:message.id,result:{models:[
    {value:'fixture-model',name:'Fixture model',configOptions:[]},
    {value:'grok-4.7',name:'Grok 4.7',configOptions:[cursorEffort]},
  ]}});
  if(cursor && message.method==='session/set_config_option'){
    const option=cursorOptions.find(item=>item.id===message.params.configId);
    if(option?.options.some(choice=>choice.value===message.params.value))option.currentValue=message.params.value;
    return send({id:message.id,result:{configOptions:cursorOptions}});
  }
  if(['session/set_config_option','session/set_mode','session/set_model'].includes(message.method))return send({id:message.id,result:{}});
  if(message.method==='session/cancel' && prompt?.params.prompt[0].text.includes('CUSTOM_CANCEL_FIXTURE')){
    notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' Cancel notification received'}});
    return send({id:prompt.id,result:{stopReason:'cancelled'}});
  }
  if(message.method==='session/prompt'){
    prompt=message;
    const text=message.params.prompt[0].text;
    if(text.startsWith('Continue the same workflow step.')){
      if(backgroundRemaining || message.params.sessionId!=='fixture-session'){
        return send({id:message.id,error:{code:-32603,message:'Background validation started before exit or in another session'}});
      }
      notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Verified background results\nWORKFLOW: DONE'}});
      return send({id:message.id,result:{stopReason:'end_turn'}});
    }
    if(text.includes('ASYNC_COMMAND_FIXTURE')){
      backgroundRemaining=2;
      commandUpdate('build','in_progress', {title:'Build',rawInput:{WaitMsBeforeAsync:500}});
      notify({sessionUpdate:'tool_call',toolCallId:'tests',name:'run_command',status:'pending',title:'Tests'});
      notify({sessionUpdate:'tool_call_update',toolCallId:'tests',status:'in_progress'});
      commandUpdate('server','in_progress', {title:'Development server',rawInput:{RunPersistent:true}});
      commandUpdate('daemon','in_progress', {title:'Daemon',rawInput:{IsDaemon:true}});
      notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Still building'}});
      send({id:message.id,result:{stopReason:'end_turn'}});
      if(!text.includes('NEVER_EXIT')){
        for(const [id, delay] of [['build',30],['tests',300]])setTimeout(()=>{
          backgroundRemaining--;
          notify({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:{exit_code:0}});
        },delay);
      }
      return;
    }
    if(text.includes('ai-team moderator control.')){
      (async()=>{
        const shape=JSON.parse(text.match(/additional keys: (\{[^\n]+\})/)[1]);
        const server=servers.find(s=>s.env?.some(e=>e.name==='RELAY_TOOLS_URL'));
        if(server){const env=Object.fromEntries(server.env.map(e=>[e.name,e.value]));let offset=0;for(;;){const response=await fetch(env.RELAY_TOOLS_URL,{method:'POST',headers:{Authorization:'Bearer '+env.RELAY_TOOLS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'chat_history_read',arguments:{offset}}})});const page=JSON.parse((await response.json()).result.content[0].text);if(page.eof)break;offset=page.nextOffset;}}
        const result={...shape,...(shape.kind==='compact'?{summary:'Fixture summary preserves goals, paths, decisions and pending work.'}:{decision:'complete',reason:'Fixture review confirms completion.'})};
        notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(result)}});send({id:message.id,result:{stopReason:'end_turn'}});
      })().catch(error=>send({id:message.id,error:{code:-32603,message:error.message}}));return;
    }
    if(text.includes('PAGED_CONTEXT_FIXTURE_LATEST')){
      (async()=>{
        if(Buffer.byteLength(text)>65536)throw new Error('Inline prompt too large');
        const server=servers.find(s=>s.env?.some(e=>e.name==='RELAY_TOOLS_URL')),env=Object.fromEntries(server.env.map(e=>[e.name,e.value]));
        const rpc=async(method,params)=>{const response=await fetch(env.RELAY_TOOLS_URL,{method:'POST',headers:{Authorization:'Bearer '+env.RELAY_TOOLS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return (await response.json()).result;};
        if(!(await rpc('tools/list')).tools.some(t=>t.name==='chat_history_read'))throw new Error('Missing history tool');
        let offset=0,full='';while(true){const result=await rpc('tools/call',{name:'chat_history_read',arguments:{offset}}),page=JSON.parse(result.content[0].text);full+=page.text;if(page.eof)break;offset=page.nextOffset;}
        const messages=JSON.parse(full);if(!messages[0].text.includes('Historical message 0')||!messages.at(-1).text.includes('PAGED_CONTEXT_FIXTURE_LATEST'))throw new Error('History lost');
        notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PAGED_CONTEXT_COMPLETE '+messages.length}});send({id:message.id,result:{stopReason:'end_turn'}});
      })().catch(error=>send({id:message.id,error:{code:-32603,message:error.message}}));return;
    }
    if(text.includes('discussion-fixture')){
      const token=text.match(/<relay_discussion_([a-f0-9]{32})>/)?.[1];
      notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Discussion fixture answer\n'+(token?'<relay_discussion_'+token+'>{"decision":"complete","reason":"Fixture assessment"}</relay_discussion_'+token+'>':'')}});
      return send({id:message.id,result:{stopReason:'end_turn'}});
    }
    if(text==='fixture-auth-error')return send({id:message.id,error:{code:-32000,message:'Authentication required'}});
    if(text==='fixture-auth-refusal')return send({id:message.id,result:{stopReason:'refusal',_meta:{'codebuddy.ai/outcome':'FAILED_MODEL_REQUEST','codebuddy.ai/errorMessage':JSON.stringify({code:-32000,message:'Authentication required',data:{category:'auth'}})}}});
    if(text==='fixture-interrupt'){notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Partial'}});return process.exit(1);}
    if(text==='fixture-wait')return;
    if(text.includes('CUSTOM_CANCEL_FIXTURE')){
      return notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting for cancellation'}});
    }
    notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Public reasoning summary'}});
    notify({sessionUpdate:'tool_call',toolCallId:'fixture-tool',title:'Inspect fixture',status:'in_progress'});
    send({id:'permission',method:'session/request_permission',params:{options:[{optionId:'once',kind:'allow_once'},{optionId:'always',kind:'allow_always'}]}});return;
  }
  if(message.id==='permission'){
    notify({sessionUpdate:'tool_call_update',toolCallId:'fixture-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'Fixture output'}}]});
    notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP_FIXTURE_COMPLETE '+prompt.params.prompt[0].text.length+' '+message.result.outcome.outcome}});
    send({id:prompt.id,result:{stopReason:'end_turn'}});
  }
});
