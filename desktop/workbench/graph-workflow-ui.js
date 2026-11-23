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

  function mount(root, roles, draft = {}) {
    const initial = structuredClone(draft);
    let nodes = initial.nodes || [makeNode('n1','执行任务',45,74,'',[{label:'完成',to:'complete'}])];
    let entry = initial.entry || nodes[0]?.id;
    let selected = entry;
    let nextId = Math.max(0,...nodes.map(node=>Number(node.id.slice(1)))) + 1;
    let rebuilding = false;
    const graphIds = new Map();
    const modelIds = new Map();
    const targets = () => [...nodes.map(node=>[node.id,node.title]),...terminals];
    const canvas = root.querySelector('.graph-canvas');
    const inspector = root.querySelector('.graph-inspector');
    const add = root.querySelector('.graph-add');
    const editor = new window.Drawflow(canvas);
    editor.start();

    function refreshNode(node) {
      const element = canvas.querySelector('#node-'+graphIds.get(node.id));
      element.querySelector('.graph-card-title').textContent = node.title || '未命名节点';
      element.querySelector('.graph-card-meta').textContent = (node.id===entry?'起点 · ':'') +
        (roles.find(role=>role.id===node.roleId)?.name || '待选择角色');
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
        const html = `<div class="graph-card-title">${esc(title)}</div>${node?'<div class="graph-card-meta"></div>':''}${exits.map((_,i)=>`<div class="graph-port-label graph-port-${i+1}"></div>`).join('')}`;
        const graphId = String(editor.addNode(id,1,exits.length,x,y,node?'graph-role':'graph-terminal',{},html));
        graphIds.set(id,graphId);
        modelIds.set(graphId,id);
        if (node) {
          const card=canvas.querySelector('#node-'+graphId);
          card.tabIndex=0;
          card.onkeydown=event=>{
            if (event.key!=='Enter' && event.key!==' ') return;
            event.preventDefault();
            selected=id;
            showNode();
          };
          refreshNode(node);
        }
      }
      nodes.forEach(node=>addCard(node.id,node.title,node.x,node.y,node));
      terminals.forEach(([id,title],i)=>addCard(id,title,650,285+i*100));
      for (const node of nodes) {
        node.exits.forEach((exit,i)=>{
          if (graphIds.has(exit.to)) editor.addConnection(graphIds.get(node.id),graphIds.get(exit.to),'output_'+(i+1),'input_1');
        });
      }
      rebuilding = false;
      refreshSelection();
    }

    function refreshSelection() {
      for (const node of nodes) {
        canvas.querySelector('#node-'+graphIds.get(node.id))?.classList.toggle('graph-selected', node.id===selected);
      }
      add.disabled = nodes.length>=24;
    }

    function showNode() {
      refreshSelection();
      const node = nodes.find(item=>item.id===selected);
      if (!node) { inspector.textContent = '请选择一个角色节点。'; return; }
      const eligible = roles.filter(role=>!node.localOnly || role.local);
      const unavailable = node.roleId && !eligible.some(role=>role.id===node.roleId);
      inspector.innerHTML = `
        <div class="graph-inspector-actions"><strong>节点设置</strong>
          <button type="button" data-graph-entry ${node.id===entry?'disabled':''}>${node.id===entry?'当前起点':'设为起点'}</button>
          <button type="button" data-graph-remove ${nodes.length===1?'disabled':''}>移除节点</button>
        </div>
        <label>节点名称<input data-field="title" maxlength="100" value="${esc(node.title)}"></label>
        <label class="graph-checkbox"><input data-field="localOnly" type="checkbox" ${node.localOnly?'checked':''}>仅使用本机角色</label>
        <label>执行角色<select data-field="roleId">${option('','请选择角色',node.roleId)}${unavailable?option(node.roleId,'原角色当前不可用',node.roleId):''}${eligible.map(role=>option(role.id,role.name+' · '+role.location,node.roleId)).join('')}</select></label>
        <label>任务提示词与验收标准<textarea data-field="instruction" rows="4" maxlength="4000">${esc(node.instruction)}</textarea></label>
        <label>最多执行次数（含首次）<input data-field="limit" type="number" min="1" max="50" value="${esc(node.limit)}"></label>
        <div class="graph-inspector-actions"><strong>结果出口</strong><button type="button" data-graph-exit ${node.exits.length===8?'disabled':''}>添加出口</button></div>
        ${node.exits.map((exit,i)=>`<fieldset class="graph-exit"><legend>出口 ${i+1}</legend>
          <label>判断条件<input data-exit-label="${i}" maxlength="200" value="${esc(exit.label)}"></label>
          <label>下一步<select data-exit-target="${i}">${option('','待连接',exit.to)}${targets().map(([id,title])=>option(id,title||'未命名节点',exit.to)).join('')}</select></label>
          <button type="button" data-exit-remove="${i}" ${node.exits.length===1?'disabled':''}>移除出口</button></fieldset>`).join('')}
      `;
      inspector.querySelectorAll('[data-field]').forEach(field=>{
        field.oninput = () => {
          const name = field.dataset.field;
          node[name] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? field.valueAsNumber : field.value;
          if (name==='localOnly') {
            if (node.localOnly && !roles.some(role=>role.id===node.roleId && role.local)) node.roleId='';
            showNode();
          }
          refreshNode(node);
        };
      });
      inspector.querySelectorAll('[data-exit-label]').forEach(input=>{input.oninput=()=>{
        node.exits[Number(input.dataset.exitLabel)].label=input.value;
        refreshNode(node);
      };});
      inspector.querySelectorAll('[data-exit-target]').forEach(select=>{select.onchange=()=>{
        node.exits[Number(select.dataset.exitTarget)].to=select.value;
        renderCanvas();
      };});
      inspector.querySelector('[data-graph-entry]').onclick=()=>{entry=node.id;nodes.forEach(refreshNode);showNode();};
      inspector.querySelector('[data-graph-remove]').onclick=()=>{
        nodes=nodes.filter(item=>item!==node);
        for (const item of nodes) for (const exit of item.exits) if (exit.to===node.id) exit.to='';
        if (entry===node.id) entry=nodes[0].id;
        selected=entry;
        renderCanvas();showNode();
      };
      inspector.querySelector('[data-graph-exit]').onclick=()=>{node.exits.push({label:'',to:''});renderCanvas();showNode();};
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
      const node=nodes.find(item=>item.id===modelIds.get(String(output_id)));
      const exit=node?.exits[Number(output_class.split('_')[1])-1];
      if (!exit) return;
      const target=modelIds.get(String(input_id));
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
    add.onclick=()=>{
      const index=nodes.length;
      const node=makeNode('n'+nextId++,'新节点',45+index%4*200,74+Math.floor(index/4)*240);
      nodes.push(node);
      selected=node.id;
      renderCanvas();showNode();
    };
    root.querySelector('.graph-zoom-in').onclick=()=>editor.zoom_in();
    root.querySelector('.graph-zoom-out').onclick=()=>editor.zoom_out();
    renderCanvas();
    showNode();
    return () => ({entry,nodes});
  }

  window.deskGraphWorkflow = {mount,starter};
})();
