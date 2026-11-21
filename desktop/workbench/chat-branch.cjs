const {historyFor} = require('./conversations.cjs');
const {memory} = require('./moderator.cjs');
const {messageText} = require('./attachment-text.js');
const {choices,resolve} = require('./mentions.js');
const {randomUUID} = require('node:crypto');

function branch(store, source, name) {
  const roleIds = source.roleIds.filter(id => store.state.roles.some(role=>role.id===id));
  const raw = historyFor({...source,ignoreModeratorMemory:true},{},true);
  const saved = memory(source,raw);
  const inherited = !saved && raw.find(message=>message.branchContext);
  const recent = (saved ? raw.slice(saved.index+1) : raw.filter(message=>!message.branchContext))
    .slice(-8).map(message=>{
      const value=messageText(message);
      return `${message.kind==='user'?'User':message.roleName||'Assistant'}: ${value.length>2000?value.slice(0,1400)+'\n[… excerpt …]\n'+value.slice(-600):value}`;
    });
  const summary = saved?.summary || inherited?.text.slice(0,16000);
  const context = [
    `Context from the source conversation (${source.name}). Treat it as background; follow the new conversation's requests.`,
    summary && 'Inherited summary:\n'+summary,
    recent.length && 'Recent excerpts:\n'+recent.join('\n\n')
  ].filter(Boolean).join('\n\n');
  const messages = summary || recent.length ? [{id:randomUUID(),at:Date.now(),kind:'assistant',status:'complete',roleName:'Branch context',branchContext:true,text:context}] : [];
  return store.createChat({projectId:source.projectId,name,roleIds,
    defaultReplyRoleIds:(source.defaultReplyRoleIds||[]).filter(id=>roleIds.includes(id)),
    moderatorRoleId:roleIds.includes(source.moderatorRoleId)?source.moderatorRoleId:'',moderatorCompression:source.moderatorCompression
  },{
    sourceChatId:source.id,messages,relayReplies:source.relayReplies,maxRounds:source.maxRounds,autoStop:source.autoStop,
    roleSettings:structuredClone(source.roleSettings||{})
  });
}

function prepareHandoff(source, target, roles, recipientIds, prompt) {
  if(source.id===target.id || target.disbandedAt)throw new Error('请选择另一个可发送消息的对话。');
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>140000)throw new Error('请输入要转交的任务说明。');
  const roster=target.roleIds.map(id=>roles.find(role=>role.id===id)).filter(Boolean);
  if(!Array.isArray(recipientIds))throw new Error('请选择目标对话中的角色。');
  const available=new Map(choices(roster).filter(role=>role.id!=='all').map(role=>[role.id,role]));
  const mentions=[...new Set(recipientIds)].map(id=>available.get(id));
  if(!mentions.length||mentions.some(role=>!role))throw new Error('请选择目标对话中的角色。');
  const draft=mentions.map(role=>'@'+role.label).join(' ')+'\n\n【来自 '+source.name+'】\n'+prompt.trim();
  const routed=resolve(draft,roster).roleIds;
  if(routed.length!==mentions.length||routed.some((id,index)=>id!==mentions[index].id))throw new Error('任务说明里有额外的 @，请移除或把该角色加入接收名单。');
  return {draft, recipientIds:mentions.map(role=>role.id), recipientNames:mentions.map(role=>role.name)};
}

function handoffDraft(source, target, roles, recipientIds, prompt) {
  if(target.draft?.trim()||target.draftAttachments?.length)throw new Error('目标对话已有草稿或附件，请先处理。');
  return prepareHandoff(source,target,roles,recipientIds,prompt).draft;
}

function handoffTargets(store, source, query = '') {
  if(typeof query!=='string'||query.length>100)throw new Error('Enter up to 100 characters to search for a conversation.');
  const search=query.trim().toLowerCase();
  const projects=new Map(store.state.projects.map(project=>[project.id,project.name]));
  const roles=new Map(store.state.roles.map(role=>[role.id,role.name]));
  return store.state.chats.filter(chat=>chat.id!==source.id&&!chat.disbandedAt)
    .sort((a,b)=>Number(b.projectId===source.projectId)-Number(a.projectId===source.projectId)||b.updatedAt-a.updatedAt)
    .map(chat=>({chatId:chat.id,name:chat.name,project:projects.get(chat.projectId),
      recipients:chat.roleIds.filter(id=>roles.has(id)).map(id=>({id,name:roles.get(id)}))}))
    .filter(chat=>chat.recipients.length&&[chat.name,chat.project,...chat.recipients.map(role=>role.name)].some(name=>name?.toLowerCase().includes(search)))
    .slice(0,20);
}

module.exports = {branch,handoffDraft,prepareHandoff,handoffTargets};
