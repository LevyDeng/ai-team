const path=require('node:path');

// These are Windows command-line arguments, not shell commands.
function quote(value){
  if(typeof value!=='string'||/[\0\r\n]/.test(value))throw new Error('Invalid launch argument.');
  return '"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
}
function launchDetails({root,executable,classic=false,packaged=false}){
  const entry=classic?path.join(root,'desktop','main.cjs'):path.join(root,'desktop','workbench','main.cjs');
  const args=packaged?(classic?'--legacy':''):quote(entry);
  const appId=classic?'local.ai-team.client':'local.ai-team.workbench';
  const name=classic?'AI 小队（经典版）':'AI 小队';
  return {appId,name,entry,shortcut:{target:executable,cwd:root,args,description:name,icon:executable,iconIndex:0,appUserModelId:appId},window:{appId,appIconPath:executable,appIconIndex:0,relaunchCommand:quote(executable)+(args?' '+args:''),relaunchDisplayName:name}};
}
function configureWindowsLaunch(app,{root,classic=false,disabled=false,platform=process.platform,executable=process.execPath}){
  const details=launchDetails({root,classic,executable,packaged:app.isPackaged});
  app.setName('AI 小队');app.setAppUserModelId(details.appId);
  if(platform==='win32'&&!disabled)app.on('browser-window-created',(_event,window)=>window.setAppDetails(details.window));
  return details;
}
module.exports={quote,launchDetails,configureWindowsLaunch};
