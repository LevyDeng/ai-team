/* Browser preview API: never reads credentials, connects SSH, or starts agents. */
(() => {
  const value=window.previewState;let changed=()=>{};
  const previewState=()=>structuredClone({...value,chats:value.chats.map(({messages,...chat})=>{
    const lastMessage=messages.findLast(message=>!message.moderatorTask);
    return {...chat,historyVersion:messages.length,lastMessage:lastMessage&&{...lastMessage,text:lastMessage.text?.slice(0,55)}};
  })});
  const sendState=()=>changed(previewState());
  const api={snapshot:async()=>structuredClone(value),on:(event,callback)=>{if(event==='state')changed=callback;return()=>{};},onFiles:()=>{},draft:async(id,text)=>{value.chats.find(c=>c.id===id).draft=text;},read:async()=>{},copy:async()=>{},pick:async()=>[],legacy:async()=>{},pause:async()=>{},settings:async settings=>{value.settings=settings;sendState();},terminals:async()=>[],files:async()=>({entries:[{name:'README.md',directory:false}],path:'D:\\example_project',text:'Layout preview only.'}),open:async()=>{},image:async()=>{throw new Error('请在桌面应用中使用剪贴板。');},'role-save':async r=>{const next={...r,id:r.id||crypto.randomUUID()};const index=value.roles.findIndex(x=>x.id===next.id);if(index<0)value.roles.push(next);else value.roles[index]=next;sendState();return next;},'chat-add':async c=>{const next={...c,id:crypto.randomUUID(),messages:[],draft:'',updatedAt:Date.now()};value.chats.unshift(next);sendState();return next;},'chat-save':async c=>{Object.assign(value.chats.find(x=>x.id===c.id),c);sendState();},'project-save':async p=>{const next={...p,id:p.id||crypto.randomUUID()};const index=value.projects.findIndex(x=>x.id===next.id);if(index<0)value.projects.push(next);else value.projects[index]=next;sendState();return next;},send:async request=>{const chat=value.chats.find(c=>c.id===request.chatId);chat.messages.push({id:crypto.randomUUID(),kind:'user',text:request.text,status:'accepted',at:Date.now()},{id:crypto.randomUUID(),kind:'system',text:'浏览器仅用于布局预览。请在桌面应用中使用真实 Agent。',at:Date.now()});chat.draft='';sendState();return {accepted:true};},models:async()=>[], 'cli-check':async()=>({message:'请在桌面应用中检查 CLI 更新。'})};
  const messages=id=>value.chats.find(chat=>chat.id===id)?.messages||[];
  Object.assign(api,{
    snapshot:async()=>previewState(),
    'project-select':async id=>{value.settings.lastProjectId=id;return value.projects.find(project=>project.id===id).lastUsedAt=Date.now();},
    'project-order':async order=>{value.settings.projectOrder=order;},
    'project-search':async(id,text)=>value.chats.filter(chat=>chat.projectId===id&&chat.messages.some(message=>message.text?.toLowerCase().includes(text.toLowerCase()))).map(chat=>chat.id),
    'chat-messages':async id=>({messages:messages(id).map(({terminal,activities,...message})=>({...message,activityCount:activities?.length||0})),older:false,newer:false}),
    'chat-search':async(id,text,offset)=>{const matches=messages(id).filter(message=>message.text?.toLowerCase().includes(text.toLowerCase())).reverse();return {matches:matches.slice(offset,offset+30).map(message=>({...message,excerpt:message.text.slice(0,160)})),total:matches.length};},
    'chat-runs':async id=>messages(id).filter(message=>message.kind==='assistant'),
    'message-details':async(id,messageId,field)=>messages(id).find(message=>message.id===messageId)?.[field],
  });
  window.desk=new Proxy(api,{get:(target,key)=>target[key]|| (async()=>{throw new Error('请在桌面应用中使用这个功能。');})});
})();
