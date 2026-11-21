const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,store,app,directory,js,errors}){
  const selected=store.saveRole({...store.state.roles[0],codexLoginSource:'desktop'}),id=selected.id;
  const until=async predicate=>{for(let i=0;i<60;i++){if(await predicate())return;await wait(50);}const details=await js(`({button:$('r-desktop-tools-toggle')?.textContent,checked:$('r-desktop-tools')?.checked,source:$('r-login-source')?.value,roleFlag:role(${JSON.stringify(id)})?.codexDesktopTools,toast:$('toast').textContent})`);throw new Error('Desktop tools settings fixture timed out: '+JSON.stringify(details));};
  await js(`(async()=>{state=await api.snapshot();showPage('roles');editRole(role(${JSON.stringify(id)}));})()`);await wait(150);
  assert.equal(await js('$('+'"r-desktop-tools-field"'+').hidden'),false);assert.equal(await js('$('+'"r-desktop-tools"'+').checked'),true);
  assert.equal(await js('$('+'"r-desktop-tools-toggle"'+').textContent'),'关闭继承');
  await js('$('+'"r-desktop-tools-toggle"'+').click();$('+'"role-form"'+').requestSubmit()');
  await until(()=>store.get('roles',id).codexDesktopTools===false);await until(()=>js('$('+'"r-desktop-tools-toggle"'+').textContent==="开启继承"'));
  await js(`editRole(role(${JSON.stringify(id)}));$('r-desktop-tools-field').scrollIntoView({block:'center'});`);await wait(150);
  assert.equal(await js('$('+'"r-desktop-tools"'+').checked'),false);assert((await js('$('+'"r-desktop-tools-field"'+').textContent')).includes('主持人'));
  fs.writeFileSync(path.join(directory,'desktop-tool-inheritance.png'),(await window.webContents.capturePage()).toPNG());
  await js('$('+'"r-desktop-tools-toggle"'+').click();$('+'"role-form"'+').requestSubmit()');await until(()=>store.get('roles',id).codexDesktopTools===true);
  await until(()=>js('$('+'"r-desktop-tools-toggle"'+').textContent==="关闭继承"'));
  await js('$('+'"r-login-source"'+').value="isolated";$('+'"r-login-source"'+').dispatchEvent(new Event("change"))');assert.equal(await js('$('+'"r-desktop-tools-field"'+').hidden'),true);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'desktop-tools-checks.json'),JSON.stringify({passed:true,checks:['inheritance enabled by default','one-click opt out','choice persists after save/reopen','participant and moderator use the same preference','one-click re-enable','only displayed for desktop-login roles','no model requests'],consoleErrors:errors},null,2));app.exit(0);
}
module.exports={run};
