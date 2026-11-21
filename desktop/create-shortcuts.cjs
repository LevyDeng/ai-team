const {app,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {launchDetails}=require('./windows-launch.cjs');
const root=path.resolve(__dirname,'..');
app.whenReady().then(()=>{
  if(process.platform!=='win32')throw new Error('Windows shortcuts require Windows.');
  const index=process.argv.indexOf('--directory');
  const directory=index<0?app.getPath('desktop'):process.argv[index+1];
  if(!directory||!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())throw new Error('Choose an existing absolute shortcut directory.');
  const variants=process.argv.includes('--both')?[false,true]:[process.argv.includes('--classic')];
  const results=[];
  for(const classic of variants){
    const details=launchDetails({root,classic,executable:process.execPath,packaged:app.isPackaged});
    const file=path.join(directory,details.name+'.lnk');
    if(!shell.writeShortcutLink(file,'create',details.shortcut))throw new Error('Could not write the application shortcut.');
    const actual=shell.readShortcutLink(file);
    if(actual.target!==details.shortcut.target||actual.args!==details.shortcut.args||actual.appUserModelId!==details.appId)throw new Error('Shortcut verification failed.');
    results.push({file,appId:actual.appUserModelId,args:actual.args});
  }
  console.log(JSON.stringify({created:results}));app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
