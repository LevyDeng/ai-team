const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const directory=process.env.RELAY_NATIVE_SESSION_FIXTURE_DIR;if(!directory)throw new Error('Fixture session directory required.');fs.mkdirSync(directory,{recursive:true});
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');let active;
function data(){return JSON.parse(fs.readFileSync(path.join(directory,active+'.json'),'utf8'));}
function save(value){fs.writeFileSync(path.join(directory,value.id+'.json'),JSON.stringify(value));}
function view(){return {sessionId:active,models:{availableModels:[{modelId:'fixture-model',name:'Fixture model'},{modelId:'fixture-model-v2',name:'Fixture model v2'}]},modes:{availableModes:[{id:'plan',name:'Plan'}]},configOptions:[{id:'model',category:'model',options:[{value:'fixture-model',name:'Fixture model'},{value:'fixture-model-v2',name:'Fixture model v2'}]},{id:'thought_level',category:'thought_level',options:[{value:'medium',name:'Medium'},{value:'high',name:'High'}]}]};}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line),params=message.params||{};
  if(message.method==='initialize')return send({id:message.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true},loadSession:true,sessionCapabilities:{resume:{}}}}});
  if(message.method==='session/new'){active=crypto.randomUUID();save({id:active,cwd:params.cwd,inputs:[],model:process.argv[process.argv.indexOf('--model')+1]||'fixture-model'});return send({id:message.id,result:view()});}
  if(['session/resume','session/load'].includes(message.method)){if(!/^[a-f0-9-]{36}$/.test(params.sessionId)||!fs.existsSync(path.join(directory,params.sessionId+'.json')))return send({id:message.id,error:{code:-32002,message:'Unknown session'}});active=params.sessionId;return send({id:message.id,result:view()});}
  if(message.method==='session/set_config_option'){const value=data();value[params.configId]=params.value;save(value);return send({id:message.id,result:{configOptions:view().configOptions}});}
  if(message.method==='session/set_mode')return send({id:message.id,result:{}});
  if(message.method==='session/prompt'){const value=data(),text=params.prompt.map(p=>p.text||'').join('\n');value.inputs.push(text);save(value);send({method:'session/update',params:{sessionId:active,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SESSION_REUSE_FIXTURE_REPLY '+value.inputs.length+' '+value.model}}}});return send({id:message.id,result:{stopReason:'end_turn'}});}
  if(message.id!==undefined)send({id:message.id,error:{code:-32601,message:'Unsupported fixture request'}});
});
