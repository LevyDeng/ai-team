const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const vendors=require('./vendor-agents.cjs');
function quotaArgs(){return ['--settings','{"colorScheme":"dark"}','--mode','plan'];}
function idleScreen(value){return value.includes('Antigravity CLI')&&value.includes('? for shortcuts')&&!/Choose your color scheme|Terms of Service|Do you trust|esc to cancel|Reading file|Thinking/.test(value);}
function usageMenu(value){return /enter\s+Select/i.test(value)&&/^\s*(?:[>❯›]\s*)?\/?usage\s+View model quota usag/im.test(value);}
class QuotaConsole{
  constructor({store,agents,network,spawn}){Object.assign(this,{store,agents,network,spawn});this.sessions=new Map();}
  async open(roleId,owner){
    const role=this.store.get('roles',roleId),location=this.store.get('locations',role.locationId);
    if(role.engine!=='antigravity'||role.provider!=='native'||location.type!=='local')throw new Error('Native quota console requires a local Antigravity account.');
    if(!owner||owner.isDestroyed())throw new Error('The quota panel is no longer available.');
    for(const existing of this.sessions.values())if(existing.owner===owner)this.stop(owner,existing.id);
    const executable=vendors.find(role);if(!executable)throw new Error('Install Antigravity CLI before viewing quota.');
    const item={id:randomUUID(),roleId:role.id,owner,stage:'waiting',lastStart:0,cols:120,rows:36};this.sessions.set(item.id,item);
    item.cleanup=()=>this.stop(owner,item.id);item.navigation=(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)item.cleanup();};
    owner.once('destroyed',item.cleanup);owner.on('did-start-navigation',item.navigation);
    item.ready=(async()=>{try{
      item.env=await this.network.environmentFor(role,this.agents.environment(role));
      if(this.sessions.get(item.id)!==item||owner.isDestroyed())throw new Error('The quota panel was closed.');
      item.executable=executable;item.cwd=path.join(this.store.directory,'quota-console-cwd');fs.mkdirSync(item.cwd,{recursive:true});
      return {kind:'quota',id:item.id,roleId:role.id,title:role.name||'Antigravity'};
    }catch(error){this.stop(owner,item.id);throw error;}})();return item.ready;
  }
  get(owner,id){const item=this.sessions.get(id);if(!item||item.owner!==owner||owner.isDestroyed())throw new Error('The quota panel is no longer available.');return item;}
  send(item,type,value){if(this.sessions.get(item.id)===item&&!item.owner.isDestroyed())item.owner.send('desk:quota',{id:item.id,type,value});}
  start(item){
    if(item.lastStart&&Date.now()-item.lastStart<3000)return;item.lastStart=Date.now();const previous=item.pty;item.pty=null;try{previous?.kill();}catch{}clearTimeout(item.menuTimer);item.stage='waiting';item.onboardingReady=false;this.send(item,'reset');
    const launch=vendors.launch(item.executable,quotaArgs(),item.env),current=this.spawn(launch.command,launch.args,{cwd:item.cwd,env:launch.env,cols:item.cols,rows:item.rows,useConptyDll:true});item.pty=current;
    current.onData(value=>{if(item.pty===current)this.send(item,'data',value);});
    current.onExit(()=>{if(item.pty===current){item.pty=null;clearTimeout(item.menuTimer);this.send(item,'ended');}});
  }
  action(owner,id,value){
    const item=this.get(owner,id),actions={up:'\x1b[A',down:'\x1b[B',left:'\x1b[D',right:'\x1b[C',pageUp:'\x1b[5~',pageDown:'\x1b[6~'};
    try{if(value==='refresh')this.start(item);else if(value==='confirm'&&item.onboardingReady){item.onboardingReady=false;item.pty?.write('\r');}else if(Object.hasOwn(actions,value)&&(item.onboardingReady||item.stage==='submitted'))item.pty?.write(actions[value]);}catch(error){this.send(item,'ended');throw error;}
  }
  screen(owner,id,value){
    const item=this.get(owner,id);if(typeof value!=='string'||value.length>40000||!item.pty)return;
    item.onboardingReady=/Choose your color scheme|Terms of Service & Data Use/.test(value)||value.includes('Do you trust the contents of this project?')&&value.includes(item.cwd)&&value.includes('> Yes, I trust this folder');if(item.onboardingReady)return;
    if(item.stage==='waiting'&&idleScreen(value)){item.stage='menu';item.pty.write('/usage');item.menuTimer=setTimeout(()=>{if(item.stage==='menu')this.send(item,'unsupported');},6000);item.menuTimer.unref?.();}
    else if(item.stage==='menu'&&usageMenu(value)){item.stage='submitted';clearTimeout(item.menuTimer);item.pty.write('\r');}
  }
  resize(owner,id,cols,rows){const item=this.get(owner,id);if(Number.isInteger(cols)&&cols>=40&&cols<=300&&Number.isInteger(rows)&&rows>=10&&rows<=120){item.cols=cols;item.rows=rows;item.pty?.resize(cols,rows);}}
  stop(owner,id){const item=this.sessions.get(id);if(!item)return;if(item.owner!==owner)throw new Error('Untrusted quota panel.');this.sessions.delete(id);clearTimeout(item.menuTimer);owner.removeListener('destroyed',item.cleanup);owner.removeListener('did-start-navigation',item.navigation);try{item.pty?.kill();}catch{}item.pty=null;}
  close(){for(const item of this.sessions.values())this.stop(item.owner,item.id);}
}
module.exports={QuotaConsole,quotaArgs,idleScreen,usageMenu};
