((root)=>{
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function editor(host,value,{save,remove,error,models}){
    host.innerHTML=`<form class="editor skill-editor" id="skill-editor"><header><h1>${value.id?'技能设置':'新建技能'}</h1><button type="submit" class="primary">保存技能</button></header><p class="hint">所有会话可用；输入 / 选择，也可由 AI 调用。</p><div class="skill-form-grid"><label>名称<input id="sk-name" value="${esc(value.name)}" placeholder="例如：生图" maxlength="60" required></label><label>斜杠命令<input id="sk-command" value="${esc(value.command)}" placeholder="例如：image" pattern="[a-z](?:[a-z0-9]|-){0,62}" required></label></div><label>简介<input id="sk-description" value="${esc(value.description)}" maxlength="300" placeholder="说明什么时候使用这个技能"></label><div class="skill-form-grid"><label class="skill-enabled"><input type="checkbox" id="sk-use-api" ${value.kind==='image'?'checked':''}>连接 API</label><label class="skill-enabled"><input type="checkbox" id="sk-enabled" ${value.enabled!==false?'checked':''}>启用，允许所有会话发现和调用</label></div><section id="sk-connection"><h3>API 设置</h3><p class="hint">目前支持生图接口，按 API 计费。</p><div class="skill-form-grid"><label>接口格式<select id="sk-provider"><option value="openai" ${value.provider!=='gemini'?'selected':''}>兼容 OpenAI 的图像接口</option><option value="gemini" ${value.provider==='gemini'?'selected':''}>Gemini 原生 API</option></select></label><label>代理<select id="sk-proxy"><option value="inherit">跟随本机位置</option><option value="direct">直连</option><option value="proxy">使用本机代理</option></select></label></div><label>API 基础地址<input id="sk-url" value="${esc(value.baseUrl||'https://api.openai.com/v1')}" placeholder="https://api.openai.com/v1"></label><label>生图模型<input id="sk-model" value="${esc(value.model)}" placeholder="留空自动选择较新的可用生图模型"></label><p class="hint">留空自动选择较新的可用模型；列表不可用时请填写模型 ID。费用由所选模型决定。</p><label>API 密钥<input type="password" id="sk-key" autocomplete="new-password" placeholder="${value.hasKey?'已加密保存；留空保留原密钥':'填写后由系统加密保存'}"></label><label class="skill-enabled"><input type="checkbox" id="sk-clear-key">删除已保存的密钥</label></section><label>技能说明<textarea id="sk-instructions" rows="13" maxlength="30000" placeholder="描述工作步骤、输入要求和输出格式；不要填写 API 密钥。" required>${esc(value.instructions)}</textarea></label><p class="hint">每次任务最多调用 3 次。</p>${value.id?'<div class="tool-actions"><button type="button" id="sk-delete" class="quiet">删除技能</button></div>':''}</form>`;
    const get=id=>host.querySelector('#'+id);get('sk-proxy').value=value.proxyMode||'inherit';
    const useApi=get('sk-use-api'),connection=get('sk-connection');
    const syncConnection=()=>{connection.hidden=!useApi.checked;};
    useApi.addEventListener('change',syncConnection);syncConnection();
    let modelVersion=0;const form=get('skill-editor'),current=()=>host.isConnected&&get('skill-editor')===form;
    if(models){
      get('sk-model').setAttribute('list','sk-model-options');get('sk-model').parentElement.insertAdjacentHTML('afterend','<datalist id="sk-model-options"></datalist><div class="tool-actions"><button type="button" id="sk-model-refresh" class="quiet">刷新模型列表</button><small id="sk-model-status" class="hint">可手动刷新模型列表</small></div>');
      const updateModels=async(force=false)=>{
        if(!useApi.checked)return;
        const version=++modelVersion;get('sk-model-refresh').disabled=true;get('sk-model-status').textContent='正在读取模型列表…';
        try{
          const result=await models({...value,provider:get('sk-provider').value,baseUrl:get('sk-url').value,proxyMode:get('sk-proxy').value,apiKey:get('sk-key').value,clearKey:get('sk-clear-key').checked},{force});
          if(version!==modelVersion||!current()||!get('sk-model-options'))return;
          get('sk-model-options').replaceChildren();for(const model of result.models){const option=document.createElement('option');option.value=model.id;option.label=model.label;get('sk-model-options').append(option);}
          get('sk-model-status').textContent=(result.warning?'刷新失败，保留缓存':result.cached?'本地缓存':'已更新')+' · '+result.models.length+' 个模型 · 自动选择：'+result.model;
          get('sk-model-status').title=result.warning||new Date(result.updatedAt).toLocaleString('zh-CN');
        }catch(e){if(version===modelVersion&&current()&&get('sk-model-status')){get('sk-model-status').textContent='列表暂不可用，请检查连接和 API 密钥 后手动刷新';get('sk-model-status').title=e.message;}}
        finally{if(version===modelVersion&&current()&&get('sk-model-refresh'))get('sk-model-refresh').disabled=false;}
      };
      get('sk-model-refresh').onclick=()=>updateModels(true);
      for(const id of ['sk-key','sk-url','sk-proxy'])get(id).addEventListener('change',()=>{get('sk-model-options').replaceChildren();updateModels();});
      get('sk-provider').addEventListener('change',()=>setTimeout(()=>{if(current()&&get('sk-model-options')){get('sk-model-options').replaceChildren();updateModels();}},0));
      const loadSavedModels=()=>{if(useApi.checked&&(value.hasKey||get('sk-key').value.trim()))updateModels();};
      useApi.addEventListener('change',()=>{
        if(useApi.checked)loadSavedModels();
        else{
          modelVersion++;
          get('sk-model-refresh').disabled=false;
          get('sk-model-status').textContent='可手动刷新模型列表';
          get('sk-model-status').removeAttribute('title');
        }
      });
      loadSavedModels();
    }
    get('sk-provider').onchange=()=>{get('sk-url').value=get('sk-provider').value==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'https://api.openai.com/v1';get('sk-model').value='';};
    form.onsubmit=async event=>{
      event.preventDefault();
      const button=form.querySelector('[type=submit]');
      button.disabled=true;
      const apiSettings=useApi.checked?{
        provider:get('sk-provider').value,baseUrl:get('sk-url').value,model:get('sk-model').value,
        proxyMode:get('sk-proxy').value,apiKey:get('sk-key').value,clearKey:get('sk-clear-key').checked
      }:{};
      try{
        await save({...value,...apiSettings,name:get('sk-name').value,command:get('sk-command').value,
          description:get('sk-description').value,kind:useApi.checked?'image':'prompt',
          enabled:get('sk-enabled').checked,instructions:get('sk-instructions').value});
      }catch(e){error(e.message);button.disabled=false;}
    };
    if(get('sk-delete'))get('sk-delete').onclick=async()=>{if(confirm('删除此技能？已生成的图片和聊天记录会保留。'))try{await remove(value.id);}catch(e){error(e.message);}};
  }
  function system(host,value,save){
    host.innerHTML=`<section class="editor skill-editor"><header><h1>${esc(value.name)}</h1><p class="hint">/${esc(value.command)} · ${esc(value.sourceLabel)} · ${esc(value.locationName)}</p></header>${value.description?`<p>${esc(value.description)}</p>`:''}<label class="skill-enabled"><input type="checkbox" id="system-skill-enabled" ${value.enabled?'checked':''}>在 AI 小队中启用</label><p class="hint">${value.userInvocable===false?'仅允许智能体调用':value.modelInvocable===false?'仅支持斜杠命令':'支持斜杠命令和智能体调用'}</p><p class="hint">${esc(value.folder)}</p><label>技能说明<textarea readonly rows="15">${esc(value.instructions)}</textarea></label></section>`;
    const toggle=host.querySelector('#system-skill-enabled');
    toggle.onchange=async()=>{
      toggle.disabled=true;
      try{if(!await save(toggle.checked))toggle.checked=!toggle.checked;}
      finally{toggle.disabled=false;}
    };
  }
  function commands(input,menu,{skills,changed}){
    let items=[],index=0,composing=false;
    function close(){menu.hidden=true;input.removeAttribute('aria-activedescendant');}
    function choose(n){const skill=items[n];if(!skill)return;input.value='/'+skill.command+' ';input.setSelectionRange(input.value.length,input.value.length);close();changed();input.focus();}
    function update(){const match=/^\s*\/([^\s/]*)$/.exec(input.value.slice(0,input.selectionStart));if(composing||!match||input.selectionStart!==input.selectionEnd){close();return;}const q=match[1].toLowerCase();items=skills().filter(s=>s.enabled&&s.userInvocable!==false&&[s.name,s.command,s.description].join(' ').toLowerCase().includes(q)).slice(0,12);index=0;menu.replaceChildren();for(const [n,s]of items.entries()){const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(n===index));const name=document.createElement('strong');name.textContent='/'+s.command+' · '+s.name;const desc=document.createElement('small');desc.textContent=(s.ready?'':s.kind==='image'?'待配置 · ':'')+s.description;button.append(name,desc);button.onpointerdown=e=>{e.preventDefault();choose(n);};menu.append(button);}menu.hidden=!items.length;}
    function keydown(event){if(menu.hidden||event.isComposing||event.keyCode===229)return false;if(event.key==='Escape'){close();return true;}if(['ArrowDown','ArrowUp'].includes(event.key)){index=(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;for(const[n,e]of [...menu.children].entries())e.setAttribute('aria-selected',String(n===index));return true;}if(['Enter','Tab'].includes(event.key)){choose(index);return true;}return false;}
    input.addEventListener('compositionstart',()=>{composing=true;close();});input.addEventListener('compositionend',()=>{composing=false;update();});input.addEventListener('blur',close);return {update,close,keydown};
  }
  function message(element,m,{open,copy,cancel,caller,review}){
    const key=JSON.stringify([m.status,m.files,m.note,m.request,m.model,m.handoff]);if(element._skillKey===key)return;element._skillKey=key;element.className='message skill';element.replaceChildren();
    const card=document.createElement('div');card.className='skill-result';const header=document.createElement('header'),title=document.createElement('strong');title.textContent='/'+m.command+' · '+m.skillName;const state=document.createElement('span');state.textContent=({running:'执行中',complete:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'})[m.status]||m.status;header.append(title,state);card.append(header);
    const who=document.createElement('small');who.className='hint';who.textContent=(caller?'由 '+caller+' 调用':'手动调用')+(m.model?' · '+m.model:'');card.append(who);const copyResult=document.createElement('button');copyResult.type='button';copyResult.className='quiet';copyResult.textContent='复制结果';copyResult.onclick=()=>copy(['/'+m.command,m.request,m.status,m.model,m.note,...(m.files||[]).map(f=>f.path)].filter(Boolean).join('\n'));card.append(copyResult);
    const details=document.createElement('details'),summary=document.createElement('summary'),request=document.createElement('pre');summary.textContent='查看请求';request.textContent=m.request||'';details.append(summary,request);card.append(details);
    if(m.handoff){
      state.textContent='待确认';
      summary.textContent='查看转交内容';
      const destination=document.createElement('p');
      destination.textContent=m.handoff.projectName+' / '+m.handoff.targetName+' · '+m.handoff.recipientNames.join(', ');
      card.insertBefore(destination,details);
      const button=document.createElement('button');button.type='button';button.textContent='确认转交';
      button.onclick=review;card.append(button);
    }
    for(const file of m.files||[]){const image=document.createElement('img');image.className='skill-image';image.alt=m.skillName;if(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(file.thumbnail||''))image.src=file.thumbnail;image.onclick=()=>open(file.path);const actions=document.createElement('div');actions.className='tool-actions';const button=document.createElement('button');button.type='button';button.textContent='打开图片';button.onclick=()=>open(file.path);const copyButton=document.createElement('button');copyButton.type='button';copyButton.textContent='复制路径';copyButton.onclick=()=>copy(file.path);actions.append(button,copyButton);card.append(image,actions);}
    if(m.note){const note=document.createElement('p');note.textContent=m.note;card.append(note);}if(m.status==='running'){const stop=document.createElement('button');stop.type='button';stop.textContent='取消技能';stop.onclick=()=>cancel(m.id);card.append(stop);}element.append(card);
  }
  root.deskSkills={editor,system,commands,message};
})(window);
