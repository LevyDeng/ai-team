(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const option = (id, label, selected) => `<option value="${esc(id)}"${id===selected?' selected':''}>${esc(label)}</option>`;
  const terminals = [['complete','结束 · 已通过'],['unresolved','结束 · 未解决']];
  const makeNode = (id, title, x, y, instruction = '', exits = [{label:'完成',to:''}], limit = 3, localOnly = false) =>
    ({id,title,x,y,instruction,exits,limit,localOnly,roleId:''});

  function starter() {
    return {title:'修复与真机验收', entry:'n1', nodes:[
      makeNode('n1','定位与规划',45,74,'检查任务涉及的代码和现象，定位问题，给出修复计划。将计划交给修复角色。',
        [{label:'已定位并给出计划',to:'n2'}],1),
      makeNode('n2','执行修复',245,74,'根据计划或上一步的反馈修改代码。报告改动和已完成的验证。',
        [{label:'修复已完成，等待审核',to:'n3'}]),
      makeNode('n3','审核',445,74,'检查实际改动及相关测试，按本次目标判断是否符合验收要求。报告问题的位置和证据。',
        [{label:'审核通过，未发现阻塞问题',to:'n4'},{label:'发现需要修复的问题',to:'n2'},{label:'证据不足，无法确认审核结果',to:'unresolved'}]),
      makeNode('n4','本地真机测试',645,74,'实际运行本机应用，执行与任务有关的测试。报告操作、观察结果和失败证据。',
        [{label:'已在本机完成测试，验收通过',to:'complete'},{label:'在本机复现缺陷，需要修复',to:'n2'},{label:'本机环境不可用或测试未能完成',to:'unresolved'}],3,true),
    ]};
  }

  function mount(root, roles, draft = {}, {chats=[], readOnly=false, progress=[]} = {}) {
    const initial = structuredClone(draft);
    const structured = initial.structured === true;
    const newRole = (id, to, x=245, y=74) => ({...makeNode(id,'执行任务',x,y,'',[{label:'完成',to}]),kind:'role'});
    initial.nodes ||= [structured?newRole('n1','complete'):makeNode('n1','执行任务',45,74,'',[{label:'完成',to:'complete'}])];
    initial.entry ??= initial.nodes[0]?.id;
    const scopes = [{graph:initial}];
    let {nodes,entry} = initial;
    let selected = entry;
    let nextId = Math.max(0,...nodes.map(node=>Number(node.id.slice(1)))) + 1;
    let rebuilding = false;
    const graphIds = new Map();
    const modelIds = new Map();
    const endings = () => scopes.length>1?[['iteration_end','本轮结束'],['loop_break','跳出循环']]:terminals;
    const targets = () => [...nodes.map(node=>[node.id,node.title]),...endings()];
    const terminalX = () => structured ? Math.max(650,...nodes.map(node=>node.x+200)) : 650;
    const canvas = root.querySelector('.graph-canvas');
    const inspector = root.querySelector('.graph-inspector');
    const add = root.querySelector('.graph-add');
    const editor = new window.Drawflow(canvas);
    editor.start();
    if (readOnly) editor.editor_mode = 'fixed';
    const tools = root.querySelector('.graph-toolbar');
    const breadcrumb = document.createElement('div');
    breadcrumb.className='graph-breadcrumb';
    if (structured) tools.before(breadcrumb);
    const addLoop = document.createElement('button'), addContext = document.createElement('button');
    addLoop.type=addContext.type='button';
    addLoop.textContent='添加循环';addContext.textContent='群聊上文';
    if (structured && !readOnly) add.after(addLoop,addContext);
    add.hidden=readOnly;

    function changeScope(depth, node) {
      Object.assign(scopes.at(-1).graph,{nodes,entry});
      const returnTo=scopes[depth]?.node?.id;
      scopes.length=depth;
      if (node) scopes.push({graph:node.body,node});
      ({nodes,entry}=scopes.at(-1).graph);
      selected=node?entry:returnTo||entry;
      nextId=Math.max(0,...nodes.map(item=>Number(item.id.slice(1))))+1;
      renderCanvas();showNode();
    }

    function changeEntry(id) {
      entry=id;
      Object.assign(scopes.at(-1).graph,{entry});
    }

    function refreshNode(node) {
      const element = canvas.querySelector('#node-'+graphIds.get(node.id));
      element.querySelector('.graph-card-title').textContent = node.title || '未命名节点';
      element.querySelector('.graph-card-meta').textContent = (node.id===entry?'起点 · ':'') +
        (node.kind==='loop'?'最多 '+node.rounds+' 轮 · '+node.body.nodes.length+' 个节点':
          node.kind==='context'?(chats.find(chat=>chat.id===node.sourceChatId)?.name||'待选择来源群聊'):
            (roles.find(role=>role.id===node.roleId)?.name || '待选择角色')+
              (node.backupRoleIds?.length?' · 替补 '+node.backupRoleIds.length+' 位':''));
      node.exits.forEach((exit,i)=>{
        const caption = element.querySelector('.graph-port-'+(i+1));
        caption.textContent = exit.label || '未命名出口';
        caption.title = caption.textContent;
        const port = element.querySelector('.output_'+(i+1));
        port.title = exit.label || '未命名出口';
        port.setAttribute('aria-label',port.title);
      });
      editor.updateConnectionNodes('node-'+graphIds.get(node.id));
    }

    function renderCanvas() {
      rebuilding = true;
      editor.clear();
      editor.node_selected = null;
      editor.connection_selected = null;
      graphIds.clear();
      modelIds.clear();
      function addCard(id, title, x, y, node) {
        const exits = node?.exits || [];
        const loop = node?.kind==='loop';
        const heading = `<div class="graph-card-title">${esc(title)}</div>`;
        const header = loop?`<div class="graph-loop-heading">${heading}<button type="button" class="graph-loop-open" aria-label="进入循环">进入 »</button></div>`:heading;
        const html = `${header}${node?'<div class="graph-card-meta"></div>':''}${exits.map((_,i)=>`<div class="graph-port-label graph-port-${i+1}"></div>`).join('')}`;
        const graphId = String(editor.addNode(id,id==='entry'?0:1,id==='entry'?1:exits.length,x,y,loop?'graph-role graph-loop':node?'graph-role':'graph-terminal',{},html));
        graphIds.set(id,graphId);
        modelIds.set(graphId,id);
        if (node) {
          const card=canvas.querySelector('#node-'+graphId);
          card.tabIndex=0;
          card.onkeydown=event=>{
            if (event.target && event.target!==card || event.key!=='Enter' && event.key!==' ') return;
            event.preventDefault();
            selected=id;
            showNode();
          };
          if (readOnly) card.onclick=()=>{selected=id;showNode();};
          if (loop) {
            const enter=()=>changeScope(scopes.length,node);
            card.ondblclick=enter;
            const button=card.querySelector('.graph-loop-open');
            button.onmousedown=event=>event.stopPropagation();
            button.ontouchstart=event=>event.stopPropagation();
            button.ondblclick=event=>event.stopPropagation();
            button.onclick=event=>{event.stopPropagation();enter();};
          }
          refreshNode(node);
        }
      }
      nodes.forEach(node=>addCard(node.id,node.title,node.x,node.y,node));
      endings().forEach(([id,title],i)=>addCard(id,title,terminalX(),structured?115+i*160:285+i*100));
      if (structured) {
        addCard('entry',scopes.length===1?'工作流入口':'循环入口',24,74);
        if (graphIds.has(entry)) editor.addConnection(graphIds.get('entry'),graphIds.get(entry),'output_1','input_1');
        breadcrumb.replaceChildren(...scopes.map(({node},index)=>{
          const button=document.createElement('button');
          button.type='button';button.className='quiet';
          button.textContent=(index?'› ':'')+(node?.title||'主流程');
          button.disabled=index===scopes.length-1;
          button.onclick=()=>changeScope(index+1);
          return button;
        }));
        if (scopes.length>1) {
          const back=document.createElement('button');
          back.type='button';back.className='graph-back';back.textContent='‹ 返回上一层';
          back.onclick=()=>changeScope(scopes.length-1);
          breadcrumb.prepend(back);
        }
      }
      for (const node of nodes) {
        node.exits.forEach((exit,i)=>{
          if (graphIds.has(exit.to)) editor.addConnection(graphIds.get(node.id),graphIds.get(exit.to),'output_'+(i+1),'input_1');
        });
      }
      rebuilding = false;
      refreshSelection();
    }

    function refreshSelection() {
      const current = scopes.slice(1).every(({node},index)=>node.id===progress[index]?.nodeId)
        ? progress[scopes.length-1]?.nodeId : undefined;
      for (const node of nodes) {
        const element=canvas.querySelector('#node-'+graphIds.get(node.id));
        element?.classList.toggle('graph-selected',node.id===selected);
        element?.classList.toggle('graph-running-node',node.id===current);
      }
      add.disabled = nodes.length>=24;
      addContext.disabled=add.disabled;
      addLoop.disabled=add.disabled||scopes.length>=4;
    }

    function showNode() {
      refreshSelection();
      const node = nodes.find(item=>item.id===selected);
      if (!node) { inspector.textContent = '请选择一个节点。'; return; }
      const eligible = roles.filter(role=>!node.localOnly || role.local);
      const backups = node.backupRoleIds || [];
      const roleOptions = (selected, choices) =>
        (selected && !choices.some(role=>role.id===selected)?option(selected,'原角色当前不可用',selected):'')+
        choices.map(role=>option(role.id,role.name+' · '+role.location,selected)).join('');
      const nextBackup = eligible.find(role=>role.id!==node.roleId && !backups.includes(role.id));
      const backupFields = `<div class="graph-inspector-actions"><strong>替补角色</strong>
        <button type="button" data-add-backup ${!nextBackup||backups.length>=99?'disabled':''}>添加替补</button></div>
        ${backups.map((id,index)=>`<div class="graph-backup-row"><label>第 ${index+1} 顺位<select data-backup-role="${index}">
          ${roleOptions(id,eligible.filter(role=>role.id===id || role.id!==node.roleId && !backups.includes(role.id)))}</select></label>
          <div class="graph-backup-actions"><button type="button" data-backup-up="${index}" aria-label="上移第 ${index+1} 顺位替补" ${index===0?'disabled':''}>↑</button>
          <button type="button" data-backup-down="${index}" aria-label="下移第 ${index+1} 顺位替补" ${index===backups.length-1?'disabled':''}>↓</button>
          <button type="button" data-remove-backup="${index}" aria-label="移除第 ${index+1} 顺位替补">移除</button></div></div>`).join('')}`;
      const roleFields = `
        <label class="graph-checkbox"><input data-field="localOnly" type="checkbox" ${node.localOnly?'checked':''}>仅使用本机角色</label>
        <label>执行角色<select data-field="roleId">${option('','请选择角色',node.roleId)}${roleOptions(node.roleId,eligible.filter(role=>!backups.includes(role.id)))}</select></label>
        ${backupFields}
        <label>任务提示词与验收标准<textarea data-field="instruction" rows="4" maxlength="4000">${esc(node.instruction)}</textarea></label>
        ${structured?'':`<label>最多执行次数（含首次）<input data-field="limit" type="number" min="1" max="50" value="${esc(node.limit)}"></label>`}`;
      const loopFields = `
        <label>循环方式<select data-field="mode">${option('fixed','固定轮数',node.mode)}${option('until','满足条件时提前跳出',node.mode)}</select></label>
        <label>最多轮次<input data-field="rounds" type="number" min="1" max="50" value="${esc(node.rounds)}"></label>
        <p class="hint">连接到「本轮结束」后自动进入下一轮。「跳出循环」结束当前这一层。</p>`;
      const contextFields = `<label>来源群聊<select data-field="sourceChatId">${option('','请选择群聊',node.sourceChatId)}
        ${node.sourceChatId&&!chats.some(chat=>chat.id===node.sourceChatId)?option(node.sourceChatId,'来源群聊已删除',node.sourceChatId):''}
        ${chats.map(chat=>option(chat.id,chat.name,node.sourceChatId)).join('')}</select></label>`;
      const customExits = node.kind !== 'loop'&&node.kind !== 'context';
      const fields = node.kind==='loop'?loopFields:node.kind==='context'?contextFields:roleFields;
      inspector.innerHTML = `
        <div class="graph-inspector-actions"><strong>节点设置</strong>
          <button type="button" data-graph-entry ${readOnly||node.id===entry?'disabled':''}>${node.id===entry?'当前起点':'设为起点'}</button>
          <button type="button" data-graph-remove ${readOnly||nodes.length===1?'disabled':''}>移除节点</button>
        </div>
        ${node.kind==='loop'?'<button type="button" data-graph-body>进入循环</button>':''}
        <fieldset class="graph-node-fields" ${readOnly?'disabled':''}>
        <label>节点名称<input data-field="title" maxlength="100" value="${esc(node.title)}"></label>${fields}
        <div class="graph-inspector-actions"><strong>结果出口</strong>${customExits?`<button type="button" data-graph-exit ${node.exits.length===8?'disabled':''}>添加出口</button>`:''}</div>
        ${customExits?`<p class="hint">${node.exits.length===1?'节点提交结果后沿唯一出口继续。':'执行角色会根据节点结果和下列条件判断出口。'}</p>`:''}
        ${node.exits.map((exit,i)=>`<fieldset class="graph-exit"><legend>出口 ${i+1}</legend>
          ${customExits?`<label>${node.exits.length===1?'出口名称':'判断条件'}<input data-exit-label="${i}" maxlength="200" value="${esc(exit.label)}"></label>`:`<p>${esc(exit.label)}</p>`}
          <label>下一步<select data-exit-target="${i}">${option('','待连接',exit.to)}${targets().map(([id,title])=>option(id,title||'未命名节点',exit.to)).join('')}</select></label>
          ${customExits?`<button type="button" data-exit-remove="${i}" ${node.exits.length===1?'disabled':''}>移除出口</button>`:''}</fieldset>`).join('')}
        </fieldset>
      `;
      const body=inspector.querySelector('[data-graph-body]');
      if (body) body.onclick=()=>changeScope(scopes.length,node);
      inspector.querySelectorAll('[data-field]').forEach(field=>{
        field.oninput = () => {
          const name = field.dataset.field;
          node[name] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? field.valueAsNumber : field.value;
          if (name==='localOnly') {
            if (node.localOnly && !roles.some(role=>role.id===node.roleId && role.local)) node.roleId='';
            if (node.localOnly) node.backupRoleIds=backups.filter(id=>roles.some(role=>role.id===id && role.local));
            showNode();
          }
          if (name==='roleId') showNode();
          if (name==='mode') {
            if (node.mode==='until') node.exits.push({label:'轮次用尽',to:''});
            else node.exits.splice(1);
            renderCanvas();showNode();
          }
          refreshNode(node);
        };
      });
      const updateBackups = ids => {node.backupRoleIds=ids;showNode();refreshNode(node);};
      const addBackup=inspector.querySelector('[data-add-backup]');
      if (addBackup && nextBackup) addBackup.onclick=()=>updateBackups([...backups,nextBackup.id]);
      inspector.querySelectorAll('[data-backup-role]').forEach(select=>{select.onchange=()=>{
        updateBackups(backups.map((id,index)=>index===Number(select.dataset.backupRole)?select.value:id));
      };});
      inspector.querySelectorAll('[data-remove-backup]').forEach(button=>{button.onclick=()=>{
        updateBackups(backups.filter((_,index)=>index!==Number(button.dataset.removeBackup)));
      };});
      inspector.querySelectorAll('[data-backup-up],[data-backup-down]').forEach(button=>{button.onclick=()=>{
        const up=button.hasAttribute('data-backup-up'), index=Number(up?button.dataset.backupUp:button.dataset.backupDown);
        const ids=[...backups], neighbor=index+(up?-1:1);
        [ids[index],ids[neighbor]]=[ids[neighbor],ids[index]];
        updateBackups(ids);
      };});
      inspector.querySelectorAll('[data-exit-label]').forEach(input=>{input.oninput=()=>{
        node.exits[Number(input.dataset.exitLabel)].label=input.value;
        refreshNode(node);
      };});
      inspector.querySelectorAll('[data-exit-target]').forEach(select=>{select.onchange=()=>{
        node.exits[Number(select.dataset.exitTarget)].to=select.value;
        renderCanvas();
      };});
      inspector.querySelector('[data-graph-entry]').onclick=()=>{changeEntry(node.id);renderCanvas();showNode();};
      inspector.querySelector('[data-graph-remove]').onclick=()=>{
        nodes=nodes.filter(item=>item!==node);
        for (const item of nodes) for (const exit of item.exits) if (exit.to===node.id) exit.to='';
        if (entry===node.id) changeEntry(structured?'':nodes[0].id);
        selected=entry;
        renderCanvas();showNode();
      };
      const addExit=inspector.querySelector('[data-graph-exit]');
      if (addExit) addExit.onclick=()=>{node.exits.push({label:'',to:''});renderCanvas();showNode();};
      inspector.querySelectorAll('[data-exit-remove]').forEach(button=>{button.onclick=()=>{
        node.exits.splice(Number(button.dataset.exitRemove),1);renderCanvas();showNode();
      };});
    }

    editor.on('nodeSelected', id=>{
      const modelId = modelIds.get(String(id));
      if (nodes.some(node=>node.id===modelId)) { selected=modelId; showNode(); }
    });
    editor.on('nodeMoved', id=>{
      const node = nodes.find(item=>item.id===modelIds.get(String(id)));
      if (node) {
        const moved=editor.getNodeFromId(id);
        node.x=moved.pos_x;
        node.y=moved.pos_y;
      }
    });
    function updateConnection({output_id,input_id,output_class}, connected) {
      if (rebuilding) return;
      const from=modelIds.get(String(output_id));
      const target=modelIds.get(String(input_id));
      if (from==='entry') {
        if (connected && !nodes.some(node=>node.id===target)) {
          editor.removeSingleConnection(output_id,input_id,output_class,'input_1');
          return;
        }
        if (connected && entry && entry!==target) editor.removeSingleConnection(output_id,graphIds.get(entry),output_class,'input_1');
        if (connected || entry===target) changeEntry(connected?target:'');
        nodes.forEach(refreshNode);showNode();
        return;
      }
      const node=nodes.find(item=>item.id===from);
      const exit=node?.exits[Number(output_class.split('_')[1])-1];
      if (!exit) return;
      if (connected && exit.to && exit.to!==target) {
        const old=graphIds.get(exit.to);
        if (old) editor.removeSingleConnection(output_id,old,output_class,'input_1');
      }
      if (connected) exit.to=target;
      else if (exit.to===target) exit.to='';
      const field=inspector.querySelector('[data-exit-target="'+(Number(output_class.split('_')[1])-1)+'"]');
      if (selected===node.id && field) field.value=exit.to;
    }
    editor.on('connectionCreated', event=>updateConnection(event,true));
    editor.on('connectionRemoved', event=>updateConnection(event,false));
    // Node removal goes through the inspector so the workflow and diagram update together.
    canvas.addEventListener('keydown',event=>{
      if (event.key==='Delete' && editor.node_selected) event.stopImmediatePropagation();
    },true);
    canvas.addEventListener('contextmenu',event=>event.stopImmediatePropagation(),true);
    function appendNode(create) {
      const index=nodes.length;
      const node=create('n'+nextId++,structured?245+(index%3)*200:45+index%4*200,74+Math.floor(index/3)*180);
      nodes.push(node);
      selected=node.id;
      renderCanvas();showNode();
    }
    add.onclick=()=>appendNode((id,x,y)=>structured?newRole(id,'',x,y):makeNode(id,'新节点',x,y));
    addLoop.onclick=()=>appendNode((id,x,y)=>({id,x,y,kind:'loop',title:'循环',rounds:3,mode:'fixed',
      exits:[{label:'完成',to:''}],body:{entry:'n1',nodes:[newRole('n1','iteration_end')]}}));
    addContext.onclick=()=>appendNode((id,x,y)=>({id,x,y,kind:'context',title:'群聊上文',sourceChatId:'',
      exits:[{label:'带入上文',to:''}]}));
    root.querySelector('.graph-zoom-in').onclick=()=>editor.zoom_in();
    root.querySelector('.graph-zoom-out').onclick=()=>editor.zoom_out();
    renderCanvas();
    showNode();
    const read = () => {
      Object.assign(scopes.at(-1).graph,{nodes,entry});
      return {entry:initial.entry,nodes:initial.nodes,...(structured?{structured:true}:{})};
    };
    read.setProgress = frames => {progress=frames||[];refreshSelection();};
    read.fit = () => {
      const width = Math.max(850,terminalX()+190,...nodes.map(node=>node.x+190));
      editor.zoom = Math.min(1,canvas.clientWidth/width);
      editor.canvas_x=0;editor.canvas_y=0;editor.zoom_refresh();
    };
    return read;
  }

  window.deskGraphWorkflow = {mount,starter};
})();
