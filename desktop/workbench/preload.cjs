const { contextBridge, ipcRenderer, webUtils } = require('electron');
const calls = ['snapshot', 'role-save', 'role-enabled', 'avatar-list', 'avatar-upload', 'role-delete', 'role-login', 'agent-info', 'agent-guide', 'agent-install', 'location-save', 'location-proxy-save', 'location-test', 'location-setup-ssh-key', 'location-delete', 'project-save', 'project-move', 'project-delete', 'chat-add', 'chat-save', 'chat-role-settings', 'chat-flow', 'chat-discussion', 'chat-order', 'chat-delete', 'draft', 'attachment-stage', 'attachment-remove', 'attachment-restore', 'read', 'send', 'pause', 'settings', 'pick', 'copy', 'clipboard-text', 'image', 'open', 'files', 'file-explorer', 'terminals', 'terminal-open', 'terminal-input', 'terminal-resize', 'terminal-close', 'models', 'cli-update-preference', 'cli-update-check', 'cli-update-install', 'account-usage', 'usage-guide', 'claude-cli'];
const api = Object.fromEntries(calls.map(name => [name, (...args) => ipcRenderer.invoke('desk:' + name, ...args)]));
for (const name of ['app-update-check', 'app-update-download', 'app-update-status', 'app-update-prepare', 'app-update-install', 'app-update-ready']) {
  api[name] = () => ipcRenderer.invoke('desk:' + name);
}
for (const name of ['project-select', 'project-order', 'project-search', 'chat-messages', 'chat-search', 'other-chats-search', 'message-details', 'chat-runs']) {
  api[name] = (...args) => ipcRenderer.invoke('desk:' + name, ...args);
}
for(const name of ['queue-resume','queue-pause','queue-remove','queue-move','queue-now','queue-restore'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
api['force-stop']=(...args)=>ipcRenderer.invoke('desk:force-stop',...args);
for(const name of ['agent-terminals','agent-terminal-open','agent-terminal-input','agent-terminal-resize','agent-terminal-close','agent-terminal-screen'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
for(const name of ['skill-get','skill-save','skill-delete','skill-cancel','skill-models','skill-sources-save','skill-enabled','message-images','message-image-original'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
for(const name of ['quota-action','quota-screen','quota-resize','quota-stop'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
for(const name of ['gemini-web-open','gemini-web-link','gemini-web-open-turn','gemini-web-clipboard-reply','gemini-web-reply'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
api['chat-session-reset']=(...args)=>ipcRenderer.invoke('desk:chat-session-reset',...args);
api['chat-disband']=(...args)=>ipcRenderer.invoke('desk:chat-disband',...args);
for(const name of ['workflow-create','workflow-resume','workflow-teams','workflow-plan','workflow-plan-cancel','workflow-generated-update'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
for(const command of ['save','start','stop','resume','finish','confirm-stop']){
  const name='workflow-group-'+command;
  api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
}
api['workflow-priority-save']=(...args)=>ipcRenderer.invoke('desk:workflow-priority-save',...args);
api['workflow-template-save']=value=>ipcRenderer.invoke('desk:workflow-template-save',value);
for(const name of ['chat-branch','chat-handoff'])api[name]=(...args)=>ipcRenderer.invoke('desk:'+name,...args);
for(const name of ['workbench-restart','workbench-quit','workbench-support'])api[name]=()=>ipcRenderer.invoke('desk:'+name);
api.on = (name, callback) => { if (!['state', 'terminal', 'message','agent-terminal','quota'].includes(name)) throw new Error('Invalid event.'); const listener = (_e, value) => callback(value); ipcRenderer.on('desk:' + name, listener); return () => ipcRenderer.removeListener('desk:' + name, listener); };
api.onFiles = (callback, drag = () => {}) => {
  let depth=0;
  const hasFiles=event=>Array.from(event.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter',event=>{if(hasFiles(event)){event.preventDefault();depth++;drag(true);}},true);
  window.addEventListener('dragover',event=>{if(hasFiles(event)){event.preventDefault();event.dataTransfer.dropEffect='copy';}},true);
  window.addEventListener('dragleave',event=>{if(hasFiles(event)){depth=Math.max(0,depth-1);if(!depth)drag(false);}},true);
  window.addEventListener('drop',event=>{
    const files=Array.from(event.dataTransfer?.files || []);if(!hasFiles(event)&&!files.length)return;
    event.preventDefault();event.stopPropagation();depth=0;drag(false);
    const paths=files.map(file=>{try{return webUtils.getPathForFile(file);}catch{return '';}}).filter(Boolean);
    callback(paths);
  },true);
  window.addEventListener('blur',()=>{depth=0;drag(false);});
};
contextBridge.exposeInMainWorld('desk', api);
