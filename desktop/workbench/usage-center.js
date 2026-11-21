(() => {
  const stateLabels={ready:'已同步',pending:'尚未查询',unsupported:'暂不支持自动查询',not_signed_in:'登录或密钥需要检查',error:'查询失败'};
  const names={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',kimi:'Kimi Code',cursor:'Cursor Agent',codebuddy:'CodeBuddy Code',workbuddy:'WorkBuddy',opencode:'OpenCode',openai:'OpenAI API',gemini:'Gemini API','gemini-web':'Gemini 网页版',deepseek:'DeepSeek API',moonshot:'Moonshot API'};
  const time=value=>value&&Number.isFinite(value)?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
  function summary(entry){
    if(!entry)return '额度未查询';
    if(entry.nativeConsole)return '应用内查看额度';
    if(entry.loading)return '正在查询额度…';
    if(entry.state==='error')return entry.updatedAt?'额度查询失败 · 有缓存':'额度查询失败';
    if(entry.state==='not_signed_in')return stateLabels[entry.state];
    const balance=entry.balances?.[0];if(balance)return 'API 余额 '+balance.remaining+' '+balance.currency;
    const window=entry.windows?.[0];if(window)return window.resetsAt&&window.resetsAt*1000<=Date.now()?'额度待更新':'剩余 '+(100-window.usedPercent).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';
    return stateLabels[entry.state]||'额度未知';
  }
  function create(container,{refresh,guide,error,api,roleIds=[],focusRole}){
    let snapshot,busy=false,disposed=false,request=0,opening=false,nativeView;const currentRoles=new Set(roleIds);
    container.innerHTML='<div class="usage-center-controls"><label>显示<select class="usage-filter"><option value="all">全部角色</option><option value="current">当前对话的角色</option></select></label><input class="usage-search" placeholder="搜索角色或 Agent" aria-label="搜索额度条目"><button type="button" class="usage-refresh-all">刷新显示项</button></div><p class="hint">按登录配置汇总，同一账号的额度共享。浅色为已用，深色为剩余。</p><div class="usage-cards"></div>';
    const filter=container.querySelector('.usage-filter'),search=container.querySelector('.usage-search'),list=container.querySelector('.usage-cards'),button=container.querySelector('.usage-refresh-all');
    const overview=document.createElement('div');overview.className='usage-overview';overview.append(...container.childNodes);container.append(overview);
    const nativeHost=document.createElement('section');nativeHost.className='native-quota-host';nativeHost.hidden=true;container.append(nativeHost);
    const back=()=>{nativeHost.hidden=true;overview.hidden=false;container.closest('dialog')?.classList.remove('native-quota-open');};
    async function showGuide(roleId){if(opening||disposed)return;opening=true;const version=++request;try{const result=await guide(roleId);if(result?.kind!=='quota')return;if(disposed||version!==request){api['quota-stop'](result.id).catch(()=>{});return;}nativeView?.destroy();nativeView=window.createQuotaView(nativeHost,{api,error,back});overview.hidden=true;nativeHost.hidden=false;container.closest('dialog')?.classList.add('native-quota-open');nativeView.open(result);}catch(problem){if(!disposed)error(problem);}finally{opening=false;}}
    filter.value='all';
    search.value=focusRole||'';
    filter.onchange=()=>render(snapshot);search.oninput=()=>render(snapshot);
    search.onkeydown=event=>{if(event.key==='Enter')event.preventDefault();};
    const entries=()=>{const q=search.value.trim().toLowerCase();return(snapshot?.accountUsage||[]).filter(entry=>{
      const roles=snapshot.roles.filter(role=>entry.roleIds.includes(role.id));return(filter.value!=='current'||roles.some(r=>currentRoles.has(r.id)))&&(!q||[names[entry.engine],names[entry.provider],...roles.map(r=>r.name)].join(' ').toLowerCase().includes(q));
    });};
    const run=async ids=>{if(busy)return;busy=true;render(snapshot);try{for(const id of ids){const next=await refresh(id);if(next)render(next);}}catch(e){error(e);}finally{busy=false;render(snapshot);}};
    button.onclick=()=>run(entries().filter(e=>e.refreshable).map(e=>e.roleIds[0]));
    function node(tag,text,className){const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;}
    function render(value){
      snapshot=value;if(!value)return;list.replaceChildren();const shown=entries();button.disabled=busy||!shown.some(e=>e.refreshable);
      for(const entry of shown){
        const card=node('article','','usage-card'),roles=value.roles.filter(role=>entry.roleIds.includes(role.id)),location=value.locations.find(l=>l.id===entry.locationId);card.dataset.state=entry.state;
        const header=node('div','','usage-card-header');header.append(node('h3',names[entry.provider==='native'?entry.engine:entry.provider]||entry.engine));
        const actions=node('div','','usage-card-actions');
        if(entry.refreshable){const reload=node('button',entry.loading?'查询中…':'刷新');reload.type='button';reload.disabled=busy||entry.loading;reload.title='刷新间隔：本机 1 分钟，VPS 5 分钟';reload.onclick=()=>run([entry.roleIds[0]]);actions.append(reload);}
        if(entry.guide){const open=node('button',entry.engine==='antigravity'&&entry.provider==='native'?'查看额度':'官方查看');open.type='button';open.onclick=()=>showGuide(entry.roleIds[0]);actions.append(open);}
        header.append(actions);card.append(header,node('p',roles.map(r=>r.name).join('、'),'usage-role-names'),node('p',(location?.name||'')+' · '+(entry.provider==='native'?'订阅 / 原生账号':'API 计费')+(roles.length>1?' · 共用登录配置':''),'hint'));
        card.append(node('p',entry.state==='ready'&&!entry.loading&&(entry.windows.length||entry.balances.length)?entry.cached?'缓存数据':'已同步':summary(entry),'usage-status'));
        for(const w of entry.windows||[]){
          const expired=w.resetsAt&&w.resetsAt*1000<=Date.now(),row=node('div','','account-usage-window'),heading=node('div','','account-usage-heading');
          const duration=w.windowMinutes===300?'5 小时':w.windowMinutes===10080?'7 天':w.windowMinutes?w.windowMinutes+' 分钟':'';
          const label=(w.label==='5h'||w.label==='7d')?duration:w.label.replace(' · Primary',' · 主要窗口').replace(' · Secondary',' · 次要窗口')+(duration?'（'+duration+'）':'');
          heading.append(node('span',label),node('strong',expired?'待更新':'剩余 '+(100-w.usedPercent).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%'));
          const progress=document.createElement('progress');progress.max=100;progress.value=w.usedPercent;progress.setAttribute('aria-label',label+' 已用 '+w.usedPercent+'%');progress.title='已用 '+w.usedPercent+'%；深色为剩余';
          row.append(heading,progress,node('small',expired?'已到重置时间，请刷新':w.resetsAt?time(w.resetsAt*1000)+' 重置':'未提供重置时间'));card.append(row);
        }
        for(const b of entry.balances||[])card.append(node('p','可用余额：'+b.remaining+' '+b.currency,'usage-balance'));
        let note='';
        if(entry.state==='error')note=entry.cached?'查询失败，以下保留上次数据，请核对更新时间。':'未能读取额度，请检查安装、登录和角色代理设置后重试。';
        else if(entry.state==='not_signed_in')note='请使用角色登录入口，或检查已保存的 API Key。';
        else if(entry.reason==='custom_endpoint')note='自定义 API 地址的计费规则无法确定，请到服务商后台查看。';
        else if(entry.state==='unsupported')note=entry.engine==='antigravity'&&entry.provider==='native'?'点击“查看额度”打开 /usage 面板。':entry.provider!=='native'?'暂不支持查询，请到服务商控制台查看。':entry.locationId!=='local'&&!entry.managed?'请在对应服务器的官方 Agent 中查看额度。':'暂不支持自动查询，请使用官方入口。';
        else if(!entry.windows.length&&!entry.balances.length)note='点击刷新查询额度。';
        if(entry.engine==='gemini-web')note='额度以 Gemini 网页上的提示为准。';
        if(note)card.append(node('p',note,'hint'));
        if(entry.source==='claude-cli-control'&&entry.windows.some(w=>/fable/i.test(w.label)))card.append(node('p','模型专项额度与账号总额度分别展示，不相加。','hint'));
        if(entry.updatedAt)card.append(node('small',(entry.cached?'缓存 · ':'更新时间 · ')+time(entry.updatedAt)+' · 本机时间','hint'));
        list.append(card);
      }
      if(!shown.length)list.append(node('p','没有符合条件的角色。','hint'));
    }
    return {render,destroy(){disposed=true;request++;nativeView?.destroy();container.closest('dialog')?.classList.remove('native-quota-open');}};
  }
  window.deskUsage={create,summary};
})();
