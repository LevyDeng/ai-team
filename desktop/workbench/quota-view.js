(() => {
  function create(container,{api,error,back}){
    let active,term,fit,observer,disposed=false,generation=0;
    container.innerHTML='<header class="native-quota-toolbar"><button type="button" class="quota-back">返回额度列表</button><strong>Antigravity · 原生额度面板</strong><button type="button" class="quota-refresh">刷新额度</button><button type="button" class="quota-copy">复制选中</button></header><div class="native-quota-actions"><button type="button" data-quota-action="up">上移</button><button type="button" data-quota-action="down">下移</button><button type="button" data-quota-action="pageUp">上一页</button><button type="button" data-quota-action="pageDown">下一页</button><span class="quota-onboarding" hidden><button type="button" data-quota-action="left">左移</button><button type="button" data-quota-action="right">右移</button><button type="button" data-quota-action="confirm">确认当前选择</button></span></div><p class="quota-status hint" role="status"></p><div class="native-quota-terminal" aria-label="Antigravity 原生额度终端"></div>';
    const status=container.querySelector('.quota-status'),onboarding=container.querySelector('.quota-onboarding'),host=container.querySelector('.native-quota-terminal');
    const report=problem=>{if(!disposed){status.textContent='额度面板未能完成读取，可刷新重试或返回额度列表。'+(problem?.message?' '+problem.message:'');error(problem);}};
    const action=value=>active?api['quota-action'](active.id,value).catch(report):Promise.resolve();
    const resize=()=>{if(!active||!term||!host.clientWidth||!host.clientHeight)return;fit.fit();api['quota-resize'](active.id,term.cols,term.rows).catch(report);};
    const stop=()=>{generation++;const old=active;active=undefined;observer?.disconnect();observer=undefined;term?.dispose();term=undefined;fit=undefined;host.replaceChildren();if(old)api['quota-stop'](old.id).catch(()=>{});};
    const unsubscribe=api.on('quota',event=>{
      if(!active||event.id!==active.id||!term)return;
      if(event.type==='data'){
        const current=term,version=generation,id=active.id;term.write(event.value,()=>{
          if(disposed||version!==generation||term!==current)return;
          let screen='';const buffer=current.buffer.active;for(let row=buffer.baseY;row<buffer.baseY+current.rows;row++)screen+=(buffer.getLine(row)?.translateToString()||'')+'\n';
          const initializing=/Choose your color scheme|Terms of Service & Data Use|Do you trust the contents of this project\?/.test(screen);onboarding.hidden=!initializing;
          status.textContent=initializing?'首次使用请阅读条款并完成设置；仅信任本工具的查询目录。':'/usage 面板 · 可刷新、翻页、复制选中文字。';
          api['quota-screen'](id,screen).catch(report);
        });
      }else if(event.type==='reset'){generation++;term.reset();onboarding.hidden=true;status.textContent='正在读取官方 /usage 面板…';}
      else if(event.type==='ended')status.textContent='额度查询进程已结束，可刷新重试；如需登录，请到角色设置完成授权。';
      else if(event.type==='unsupported')status.textContent='未确认原生 /usage 菜单，未提交任何消息。请更新官方 CLI 后重试。';
    });
    container.querySelector('.quota-back').onclick=()=>{stop();back();};
    container.querySelector('.quota-refresh').onclick=()=>action('refresh');
    container.querySelector('.quota-copy').onclick=()=>{const value=term?.getSelection();if(value)api.copy(value).catch(report);else status.textContent='请先在额度终端中选中文字，再复制。';};
    container.querySelectorAll('[data-quota-action]').forEach(button=>button.onclick=()=>action(button.dataset.quotaAction));
    return {
      open(value){if(disposed){api['quota-stop'](value.id).catch(()=>{});return;}stop();active=value;container.querySelector('strong').textContent=value.title+' · Antigravity 额度';onboarding.hidden=true;status.textContent='正在读取官方 /usage 面板…';
        try{
        term=new Terminal({fontSize:14,fontFamily:'Cascadia Mono, Consolas, monospace',disableStdin:true,convertEol:true,theme:{background:'#15191e',foreground:'#d7e0e9'}});fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(host);
        window.relayTerminalUI.installCopy(term,host,{copy:text=>api.copy(text),readOnly:true,error:report});observer=new ResizeObserver(resize);observer.observe(host);resize();action('refresh');
        }catch(problem){stop();status.textContent='无法初始化额度终端，请完全退出并重新打开 Relay Desk 后重试。';host.textContent='额度终端加载失败。可以返回额度列表，或关闭此窗口。';error(problem);}
      },
      destroy(){disposed=true;stop();unsubscribe();}
    };
  }
  window.createQuotaView=create;
})();
