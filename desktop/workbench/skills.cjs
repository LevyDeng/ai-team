const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {limitedJson}=require('./skills-json.cjs');
const imageModels=require('./image-models.cjs');
const {handoffTargets,prepareHandoff}=require('./chat-branch.cjs');
const {SystemSkills}=require('./system-skills.cjs');
const slug=/^[a-z][a-z0-9-]{0,62}$/;
function endpoint(value){const url=new URL(String(value));if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Use an HTTPS API base URL, or HTTP on localhost.');return url.href.replace(/\/+$/,'');}
function parseCommand(text, skills, { rejectDisabled = false } = {}) {
  const match = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text || '');
  if (!match) return null;
  const skill = skills.find(s => s.command === match[1] || !s.source && s.name === match[1]);
  if (skill?.enabled === false && rejectDisabled) {
    throw new Error('技能「' + skill.name + '」已停用，请在技能设置中启用后再试。');
  }
  return skill?.enabled && skill.userInvocable !== false ? { skill, prompt: (match[2] || '').trim() } : null;
}
function body(markdown){return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();}
class Skills{
  constructor({store,vault,network,fetch:request=fetch,nativeImage,emit=()=>{},systemDirectories,locations,readAvailability}){Object.assign(this,{store,vault,network,request,nativeImage,emit,readAvailability});this.root=path.join(store.directory,'skills');this.outputs=path.join(store.directory,'skill-output');this.modelCatalogs=new imageModels.ImageModelCatalogs(store.directory);this.tasks=new Map();this.jobs=new Map();this.retries=new Map();this.closed=false;store.state.skills||=[];
    this.system=new SystemSkills(store,systemDirectories,locations);
    if(!store.state.skillsInitialized){const markdown=fs.readFileSync(path.join(__dirname,'skills/image/SKILL.md'),'utf8');this.save({command:'image',name:'生图',description:'按文字要求生成图片，结果保存在本机。',kind:'image',enabled:true,instructions:body(markdown),provider:'openai',baseUrl:'https://api.openai.com/v1',model:'',proxyMode:'inherit'});store.state.skillsInitialized=true;store.save();}
    if(!store.state.handoffSkillInitialized){
      let command='handoff',name='Handoff',suffix=2;
      while(store.state.skills.some(skill=>[skill.command,skill.name].some(value=>value===command||value===name))){
        command='handoff-'+suffix;name='Handoff-'+suffix;suffix++;
      }
      const instructions=body(fs.readFileSync(path.join(__dirname,'skills/handoff/SKILL.md'),'utf8'));
      const skill=this.save({command,name,description:'Prepare a task for selected roles in another conversation.',kind:'prompt',instructions});
      store.state.handoffSkillInitialized=true;
      store.state.handoffSkillId=skill.id;
      store.save();
    }
  }
  list() {
    const availability = this.readAvailability?.();
    const appSkills = this.store.state.skills.map(skill => {
      const hasKey = this.vault.has('skill:' + skill.id);
      const enabled = availability ? availability.enabledAppSkills.has(skill.id) : skill.enabled !== false;
      return { ...skill, enabled, hasKey, ready: skill.kind === 'prompt' || hasKey };
    });
    return [...appSkills, ...this.system.list(appSkills, availability?.disabledSystemSkills)];
  }
  get(id){const skill=this.list().find(s=>s.id===id);if(!skill)throw new Error('Skill not found.');return skill;}
  read(id){
    const skill=this.get(id);
    return skill.source?this.system.read(skill):{...skill,instructions:body(fs.readFileSync(path.join(this.root,skill.id,'SKILL.md'),'utf8'))};
  }
  instructions(id) {
    const skill=this.read(id);
    if(!skill.source)return skill.instructions;
    if(skill.locationId!=='local'){
      const folder=skill.runtimeFolder?skill.runtimeFolder+' inside the managed agent, or '+skill.folder+' on the SSH host':skill.folder;
      return `${skill.sourceLabel} skill from the ${skill.locationName} SSH location. Referenced resources are relative to ${folder}. Use tools that can access that location.\n\n${skill.instructions}`;
    }
    return `Local ${skill.sourceLabel} skill. Referenced resources are relative to ${skill.folder} on the ai-team Windows machine. Use the available tools and permissions to access them.\n\n${skill.instructions}`;
  }
  async models(value,{force=false}={}){
    const saved=value.id?this.get(value.id):null,provider=value.provider==='gemini'?'gemini':'openai',base=endpoint(value.baseUrl||(provider==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'https://api.openai.com/v1'));
    const key=String(value.apiKey||(!value.clearKey&&saved&&saved.provider===provider&&endpoint(saved.baseUrl)===base?this.vault.get('skill:'+saved.id):'')||'').trim();if(!key)throw new Error('Enter an API key to load image models. Save changed provider settings first or enter its own key.');
    const role={locationId:'local',proxyMode:value.proxyMode||'inherit',provider,baseUrl:base},proxy=this.network?.policy?this.network.policy(role):role.proxyMode;
    const request=this.network?await this.network.fetchFor(role):this.request;
    return this.modelCatalogs.request({provider,base,key,proxy,request},{force});
  }
  save(value){const previous=value.id?this.store.state.skills.find(s=>s.id===value.id):null;if(value.id&&!previous)throw new Error('Only ai-team skills can be edited here.');const command=String(value.command||'').trim(),name=String(value.name||'').trim(),instructions=String(value.instructions||'').trim();
    if(!slug.test(command)||!name||name.length>60||/[\s/@]/.test(name)||!instructions||instructions.length>30000)throw new Error('Enter a unique command, a short name without spaces, and skill instructions.');
    if(!['prompt','image'].includes(value.kind))throw new Error('Choose a supported skill type.');
    if(this.store.state.skills.some(s=>s.id!==previous?.id&&[s.command,s.name].some(x=>[command,name].includes(x))))throw new Error('Skill name or command is already used.');
    const id=previous?.id||crypto.randomUUID();if([...this.jobs.values()].some(j=>j.skillId===id))throw new Error('Wait for this skill to finish before editing it.');
    const key=String(value.apiKey||'').trim();if((key&&instructions.includes(key))||(!key&&this.vault.get('skill:'+id)&&instructions.includes(this.vault.get('skill:'+id))))throw new Error('Keep API keys in the credential field, not in skill instructions.');
    const record={id,command,name,description:String(value.description||'').trim().slice(0,300),kind:value.kind,enabled:value.enabled!==false,provider:value.provider==='gemini'?'gemini':'openai',baseUrl:endpoint(value.baseUrl||(value.provider==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'https://api.openai.com/v1')),model:String(value.model||'').trim().slice(0,200),proxyMode:['inherit','direct','proxy'].includes(value.proxyMode)?value.proxyMode:'inherit'};
    if(/[\r\n\0]/.test(record.model))throw new Error('Invalid image model ID.');
    if(key)this.vault.set('skill:'+id,key);else if(value.clearKey===true)this.vault.remove('skill:'+id);
    const directory=path.join(this.root,id), filename=path.join(directory,'SKILL.md');
    const markdown='---\nname: '+command+'\ndescription: '+JSON.stringify(record.description||name)+'\n---\n\n'+instructions+'\n';
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== markdown) {
      fs.mkdirSync(directory,{recursive:true});
      const temporary=path.join(directory,crypto.randomUUID()+'.tmp');
      fs.writeFileSync(temporary,markdown,{mode:0o600});
      fs.renameSync(temporary,filename);
    }
    if(previous)Object.assign(previous,record);else this.store.state.skills.push(record);this.store.save();return this.read(id);
  }
  setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('请选择是否启用此技能。');
    const skill = this.get(id);
    if (skill.source) return this.system.setEnabled(skill, enabled);
    const record = this.store.state.skills.find(item => item.id === id);
    const previous = record.enabled;
    if (previous === enabled) return;
    record.enabled = enabled;
    try {
      this.store.save();
    } catch (error) {
      record.enabled = previous;
      throw error;
    }
  }
  remove(id){if(this.get(id).source)throw new Error('System skills are managed at their source.');if([...this.jobs.values()].some(j=>j.skillId===id))throw new Error('Wait for this skill to finish before deleting it.');this.store.state.skills=this.store.state.skills.filter(s=>s.id!==id);this.vault.remove('skill:'+id);this.store.save();}
  begin(taskId){if(!this.tasks.has(taskId))this.tasks.set(taskId,{used:0,active:0,at:Date.now()});return this.tasks.get(taskId);}
  scope(chatId,roleId,taskId,workflowRunId){return {chatId,roleId,taskId,workflowRunId,depth:0};}
  handoffSkill(list=this.list()){return list.find(skill=>skill.id===this.store.state.handoffSkillId&&skill.enabled&&skill.kind==='prompt');}
  tools(){
    const list=this.list().filter(s=>s.enabled&&s.modelInvocable!==false);if(!list.length)return [];
    const tools=[
      {name:'skill_read',description:'Read a global ai-team skill before using it. Available skills: '+list.map(s=>s.command+' ('+s.description+')').join('; '),inputSchema:{type:'object',properties:{skill:{type:'string',enum:list.map(s=>s.command)}},required:['skill'],additionalProperties:false}},
      {name:'skill_run',description:'Execute an enabled ai-team skill. Images run on the App machine with encrypted credentials; return paths, never image bytes. The shared user-task budget is 3 calls, including retries. Executors cannot recursively invoke another skill. Use the same requestId to retry an uncertain submission.',inputSchema:{type:'object',properties:{skill:{type:'string',enum:list.map(s=>s.command)},prompt:{type:'string',maxLength:16000},requestId:{type:'string',maxLength:100}},required:['skill','prompt'],additionalProperties:false}}
    ];
    const handoff=this.handoffSkill(list);
    if(handoff)tools.push(
      {name:'skill_handoff_targets',description:'When the user asks to hand off a task, find destination conversations and their participant IDs. Returns only names and IDs. Read the '+handoff.command+' skill for instructions.',
        inputSchema:{type:'object',properties:{query:{type:'string',maxLength:100}},additionalProperties:false}},
      {name:'skill_handoff_prepare',description:'When the user asks for a handoff, prepare a review card in this chat with a written prompt and selected recipients. The user reviews and sends the draft. Counts toward the shared skill budget. Reuse requestId on retry.',
        inputSchema:{type:'object',properties:{targetChatId:{type:'string'},recipientIds:{type:'array',items:{type:'string'},minItems:1,uniqueItems:true},prompt:{type:'string',maxLength:16000},requestId:{type:'string',minLength:1,maxLength:100}},required:['targetChatId','recipientIds','prompt','requestId'],additionalProperties:false}}
    );
    return tools;
  }
  async call(scope,name,args){
    if(!scope?.chatId||!scope.taskId||scope.depth)throw new Error('Nested skill execution is not allowed.');
    if(name==='skill_handoff_targets'||name==='skill_handoff_prepare')return this.callHandoff(scope,name,args);
    if(!args||Object.keys(args).some(k=>!['skill','prompt','requestId'].includes(k)))throw new Error('Invalid skill arguments.');const skill=this.list().find(s=>s.enabled&&s.modelInvocable!==false&&s.command===args.skill);if(!skill)throw new Error('This skill is unavailable for agent invocation.');
    if(name==='skill_read')return {name:skill.name,command:skill.command,kind:skill.kind,instructions:this.instructions(skill.id),ready:skill.ready};
    if(name!=='skill_run')throw new Error('Unknown skill tool.');return this.run(scope,skill.id,args.prompt,args.requestId);
  }
  callHandoff(scope,name,args){
    const skill=this.handoffSkill();
    if(!skill)throw new Error('Enable the handoff skill in the App first.');
    const source=this.store.get('chats',scope.chatId);
    if(name==='skill_handoff_targets'){
      if(!args||Object.keys(args).some(key=>key!=='query'))throw new Error('Invalid handoff search arguments.');
      return {targets:handoffTargets(this.store,source,args.query)};
    }
    if(!args||Object.keys(args).some(key=>!['targetChatId','recipientIds','prompt','requestId'].includes(key))
      ||typeof args.targetChatId!=='string'||typeof args.requestId!=='string'
      ||!Array.isArray(args.recipientIds)||args.recipientIds.some(id=>typeof id!=='string')
      ||new Set(args.recipientIds).size!==args.recipientIds.length)throw new Error('Invalid handoff arguments.');
    return this.run(scope,skill.id,args.prompt,args.requestId,{targetChatId:args.targetChatId,recipientIds:args.recipientIds});
  }
  validate(id,prompt){const skill=this.get(id);if(!skill.enabled)throw new Error('This skill is disabled.');if(typeof prompt!=='string'||!prompt.trim()||prompt.length>16000)throw new Error('Enter a skill request of at most 16,000 characters.');if(skill.kind==='image'&&!this.vault.has('skill:'+id))throw new Error('请先到“技能”配置生图服务的 API Key；模型可以留空自动选择。');return skill;}
  run(scope,id,prompt,requestId,destination){if(this.closed)throw new Error('ai-team is closing.');const skill=structuredClone(this.validate(id,prompt));const source=this.store.get('chats',scope.chatId);if(scope.depth)throw new Error('Nested skill execution is not allowed.');if(requestId!==undefined&&(typeof requestId!=='string'||!requestId||requestId.length>100))throw new Error('Invalid request ID.');
    const retryKey=requestId?scope.taskId+':'+scope.roleId+':'+requestId:null;const signature=JSON.stringify([id,prompt,destination]);if(retryKey&&this.retries.has(retryKey)){const prior=this.retries.get(retryKey);if(prior.signature!==signature)throw new Error('Request ID was already used for a different request.');return prior.promise;}
    let handoff;
    if(destination){
      const target=this.store.get('chats',destination.targetChatId);
      const {recipientIds,recipientNames}=prepareHandoff(source,target,this.store.state.roles,destination.recipientIds,prompt);
      handoff={targetChatId:target.id,targetName:target.name,projectName:this.store.get('projects',target.projectId).name,recipientIds,recipientNames};
    }
    const task=this.begin(scope.taskId);if(task.used>=3)throw new Error('本次任务已达到 3 次技能调用上限；如需继续，请发送一条新消息。');if(task.active||skill.kind==='image'&&this.jobs.size>=2)throw new Error('A skill is already running. Wait for it to finish.');task.used++;task.active++;
    const promise=this.execute({...scope,depth:1},skill,prompt,handoff).then(result=>({...result,budget:{used:task.used,limit:3}})).finally(()=>{task.active--;});if(retryKey)this.retries.set(retryKey,{signature,promise});return promise;
  }
  async execute(scope,skill,prompt,handoff){
    if(handoff){
      const message=this.store.message(scope.chatId,{kind:'skill',skillId:skill.id,skillName:skill.name,command:skill.command,workflowRunId:scope.workflowRunId,
        callerRoleId:scope.roleId||null,text:'A task handoff is ready for user review.',request:prompt,status:'complete',handoff});
      this.emit({chatId:scope.chatId,message});
      return {messageId:message.id,status:'ready_for_review',...handoff};
    }
    const message=this.store.message(scope.chatId,{kind:'skill',skillId:skill.id,skillName:skill.name,command:skill.command,callerRoleId:scope.roleId||null,text:'',request:prompt,status:'running',files:[],workflowRunId:scope.workflowRunId});const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300000);this.jobs.set(message.id,{controller,skillId:skill.id,chatId:scope.chatId,taskId:scope.taskId});this.emit({chatId:scope.chatId,message});
    try{let result;if(skill.kind==='prompt')result={instructions:this.instructions(skill.id),task:prompt};else result=await this.image(skill,prompt,controller.signal,message.id,model=>{message.model=model;this.store.save();this.emit({chatId:scope.chatId,message});});
      if(controller.signal.aborted)throw new Error('Skill cancelled.');message.status='complete';message.text=skill.kind==='prompt'?'已载入技能说明。':'已在本机生成图片。'+result.files.map(f=>f.path).join('\n');message.files=result.files||[];return {...result,...(result.files?{files:result.files.map(({thumbnail,...file})=>file)}:{})};
    }catch(error){message.status=controller.signal.aborted?'cancelled':'failed';
      if(error.apiError)message.apiError=error.apiError;
      const hint=({quota:'API 额度或预算不足，请检查该 API Key 所属项目的账单与限额；重复发送不会解决。',rate_limit:'接口请求限速，请按 Retry-After 提示等待后再试。',authentication:'API 身份验证失败，请检查技能中配置的 API Key。',access:'接口拒绝访问，请检查所选模型的权限和账号要求。'})[error.apiError?.category]||'';
      message.note=controller.signal.aborted?'技能已取消；服务端若已接收请求，仍可能计费。':[hint,String(error.message)].filter(Boolean).join('\n').slice(0,1600).split(this.vault.get('skill:'+skill.id)||'\0').join('[redacted]');throw new Error(message.note);
    }finally{clearTimeout(timer);this.jobs.delete(message.id);this.store.save();this.emit({chatId:scope.chatId,message});}
  }
  async image(skill,prompt,signal,jobId,onModel=()=>{}){const key=this.vault.get('skill:'+skill.id);const request=this.network?await this.network.fetchFor({locationId:'local',proxyMode:skill.proxyMode,provider:skill.provider,baseUrl:skill.baseUrl}):this.request;
    let used=0;try{for(const folder of fs.readdirSync(this.outputs,{withFileTypes:true}))if(folder.isDirectory())for(const f of fs.readdirSync(path.join(this.outputs,folder.name)))used+=fs.statSync(path.join(this.outputs,folder.name,f)).size;}catch(error){if(error.code!=='ENOENT')throw error;}if(used>512*1024*1024)throw new Error('技能图片目录超过 512 MiB，请整理输出文件后再生成。');
    const base=endpoint(skill.baseUrl),model=skill.model||(await this.models(skill)).model;onModel(model);if(signal.aborted)throw new Error('Skill cancelled.');
    const headers={'Content-Type':'application/json'},url=skill.provider==='gemini'?base+'/models/'+encodeURIComponent(model)+':generateContent':base+'/images/generations';
    let data;if(skill.provider==='gemini'){headers['x-goog-api-key']=key;data={contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['TEXT','IMAGE']}};}else{headers.Authorization='Bearer '+key;data={model,prompt,n:1};}
    const result=await limitedJson(await request(url,{method:'POST',headers,body:JSON.stringify(data),signal,redirect:'error'}),48*1024*1024,{secret:key});let bytes,mime;
    if(skill.provider==='gemini'){const part=result.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data||p.inline_data?.data),inline=part?.inlineData||part?.inline_data;bytes=inline?.data;mime=inline?.mimeType||inline?.mime_type;}
    else {bytes=result.data?.[0]?.b64_json;mime='image/png';}
    if(!bytes)throw new Error('服务未返回图片数据。OpenAI 兼容接口需返回 b64_json；请检查模型与接口格式。');if(typeof bytes!=='string'||bytes.length>32*1024*1024||!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(bytes))throw new Error('Invalid or oversized image data.');
    const buffer=Buffer.from(bytes,'base64');if(buffer.length>24*1024*1024)throw new Error('Generated image exceeds 24 MiB.');if(signal.aborted)throw new Error('Skill cancelled.');
    const image=this.nativeImage.createFromBuffer(buffer);if(image.isEmpty())throw new Error('The provider returned an unreadable image.');const size=image.getSize();if(size.width>16384||size.height>16384||size.width*size.height>40*1024*1024)throw new Error('Generated image dimensions exceed the limit.');
    const png=image.toPNG();if(png.length>24*1024*1024||used+png.length>512*1024*1024)throw new Error('生成图片超过本机输出容量限制，请整理技能图片目录后重试。');const folder=path.join(this.outputs,jobId);fs.mkdirSync(folder,{recursive:true});const filename=path.join(folder,'image.png');fs.writeFileSync(filename,png,{mode:0o600});
    const scale=Math.min(1,320/size.width,320/size.height);const thumbnail=image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale))}).toJPEG(78).toString('base64');return {model,files:[{id:jobId,name:'image.png',path:filename,mimeType:'image/png',width:size.width,height:size.height,thumbnail:'data:image/jpeg;base64,'+thumbnail}],note:'Files are on the Windows App machine. Use Windows project tools to inspect them; do not treat these as VPS paths.'};
  }
  cancel(chatId,id){const job=this.jobs.get(id);if(job?.chatId===chatId)job.controller.abort();}
  closeTask(taskId){for(const job of this.jobs.values())if(job.taskId===taskId)job.controller.abort();}
  close(){this.closed=true;for(const job of this.jobs.values())job.controller.abort();}
}
module.exports={Skills,parseCommand,endpoint,limitedJson};
