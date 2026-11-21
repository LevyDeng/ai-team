const { id } = require('./store.cjs');
function seed(store, root) {
  const roles = store.state.roles.slice(0, 3).map((r,i) => ({...r, name:['游戏顾问','代码专家','独立审稿'][i], locationId:'local',engine:['codex','claude','opencode'][i],provider:'native',avatar:i,model:'',persona:'',examples:''}));
  const project = {id:id(),name:'幻想乡 ARPG',roleIds:roles.map(r=>r.id),directories:[{locationId:'local',path:root}]};
  const now=Date.now();
  const messages = [
    {id:id(),kind:'user',text:'一起讨论这个项目的下一步，先各自提出方案。',status:'accepted',at:now-180000},
    ...roles.map((r,i)=>({id:id(),kind:'assistant',roleId:r.id,roleName:r.name,locationId:'local',model:'',text:['建议先做一个区域的玩法闭环，再扩展全图。','我会先检查现有结构，列出实现步骤和验证方式。','还需要确认验收标准，避免只凭截图判断。'][i],status:'complete',at:now-120000+i*10000})),
  ];
  // This fixture explicitly exercises full-roster discussion.
  const chat={id:id(),projectId:project.id,name:'项目讨论组',roleIds:roles.map(r=>r.id),defaultReplyRoleIds:roles.map(r=>r.id),messages,draft:'',updatedAt:now,unread:false};
  const direct=roles.slice(0,2).map((r,i)=>({id:id(),projectId:project.id,name:r.name,roleIds:[r.id],messages:[],draft:'',updatedAt:now-(i+1)*3600000,unread:false}));
  direct.push({id:id(),projectId:project.id,name:'场景方案评审',roleIds:roles.map(r=>r.id),messages:[],draft:'',updatedAt:now-86400000,unread:false});
  store.state.projects=[project];store.state.roles=roles;store.state.chats=[chat,...direct];for(const c of store.state.chats)require('./conversations.cjs').initialize(c,roles);store.save();return {project,chat,roles};
}
module.exports={seed};
