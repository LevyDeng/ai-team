(() => {
  const ratings = window.deskWorkflowRatings;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const option = (value, name, selected) => `<option value="${escape(value)}" ${value===selected?'selected':''}>${escape(name)}</option>`;

  function suggestions(prefix, catalog) {
    return `<datalist id="${prefix}-domains">${catalog.domains.map(name=>option(name,name)).join('')}</datalist><datalist id="${prefix}-duties">${catalog.duties.map(name=>option(name,name)).join('')}</datalist>`;
  }

  function priorityView(host, { rules, roles, roleAvatar, edit, icon }) {
    host.innerHTML = `<div class="editor priority-page" id="workflow-priorities">
      <div class="priority-heading"><div><h1>角色优先级</h1><p>为每种场景和职责配置工作流的自动选人规则。</p></div>
        <button type="button" class="primary" id="priority-new">${icon('plus')}新增规则</button></div>
      <div class="priority-surface">
        <div class="priority-toolbar"><label class="search">${icon('search')}<input id="priority-search" type="search" placeholder="搜索场景、职责或角色" aria-label="搜索优先级规则"></label><span class="hint" id="priority-count"></span></div>
        <div class="priority-scroll"><table class="priority-table"><thead><tr><th scope="col">场景</th><th scope="col">职责</th><th scope="col">优先档与候选角色</th><th scope="col"><span class="priority-action-heading">操作</span></th></tr></thead><tbody></tbody></table></div>
        <div id="priority-empty" class="priority-empty" hidden></div>
      </div>
      <p class="priority-caption hint">从最高优先档开始。同档按权重抽选，候选不可用时依次递补。</p></div>`;
    const root = host.querySelector('#workflow-priorities');
    const search = root.querySelector('#priority-search');
    const body = root.querySelector('tbody'), empty = root.querySelector('#priority-empty');
    let lastKey;
    function render() {
      const entries = rules();
      const roster = new Map(roles().map(role => [role.id,role]));
      const query = search.value.trim().toLocaleLowerCase();
      const key = JSON.stringify([query,entries,[...roster.values()].map(({id,name,engine,enabled,avatarUrl})=>[id,name,engine,enabled,avatarUrl])]);
      if (key === lastKey) return;
      lastKey = key;
      const matches = entries.filter(rule => [rule.domain,rule.duty,...rule.candidates.map(item=>roster.get(item.roleId)?.name)]
        .join(' ').toLocaleLowerCase().includes(query));
      root.querySelector('#priority-count').textContent = query ? `${matches.length} / ${entries.length} 条规则` : `${entries.length} 条规则`;
      root.querySelector('.priority-scroll').hidden = !matches.length;
      empty.hidden = Boolean(matches.length);
      empty.innerHTML = entries.length ? '<strong>没有匹配的规则</strong><span>试试其他场景、职责或角色名称。</span>' :
        '<strong>还没有角色优先级规则</strong><span>例如为「代码 × 审核」添加候选角色。</span>';
      body.innerHTML = matches.map(rule => {
        const groups = ratings.tiers(rule.candidates).map(([tier, candidates]) => `<div class="priority-tier"><span class="priority-tier-name">第 ${tier} 档</span><div class="priority-chips">${candidates.map(item => {
          const role = roster.get(item.roleId);
          const unavailable = !role || role.enabled === false || role.engine === 'gemini-web';
          return `<span class="priority-chip${unavailable ? ' is-unavailable' : ''}">${role ? roleAvatar(role) : ''}<span>${escape(role?.name || '已移除角色')}${unavailable && role ? ' <small>不可选</small>' : ''}</span><b title="抽选权重">×${item.weight}</b></span>`;
        }).join('')}</div></div>`).join('');
        return `<tr><th scope="row">${escape(rule.domain)}</th><td>${escape(rule.duty)}</td><td>${groups}</td><td><button type="button" class="quiet" data-priority-id="${escape(rule.id)}" aria-label="编辑 ${escape(rule.domain)} ${escape(rule.duty)}">${icon('edit')}编辑</button></td></tr>`;
      }).join('');
    }
    root.querySelector('#priority-new').onclick = () => edit();
    search.oninput = render;
    body.onclick = event => {
      const editButton = event.target.closest('[data-priority-id]');
      if (editButton) edit(rules().find(rule => rule.id === editButton.dataset.priorityId));
    };
    render();
    return render;
  }

  function editPriority(host, rule, roles, catalog, remove) {
    host.innerHTML = `<div class="priority-editor">
      <div class="priority-pair"><label>场景<input id="priority-domain" list="priority-rule-domains" maxlength="40" placeholder="例如代码" value="${escape(rule?.domain)}" required></label>
        <label>职责<input id="priority-duty" list="priority-rule-duties" maxlength="40" placeholder="例如审核" value="${escape(rule?.duty)}" required></label></div>
      ${suggestions('priority-rule',catalog)}<div class="priority-editor-section"><h3>候选角色</h3><p class="hint">档位数字越小越优先。同档抽选比例根据已启用角色的权重估算。</p></div>
      <div class="priority-candidate-head" aria-hidden="true"><span>角色</span><span>档位</span><span>权重</span><span>同档比例</span><span></span></div>
      <div id="priority-candidates"></div>
      <div class="priority-editor-actions"><button type="button" id="priority-add-candidate">添加候选</button>
        ${rule ? '<button type="button" class="quiet priority-delete" id="priority-delete">删除规则</button>' : ''}</div>
      <p id="priority-error" class="message-note" role="alert" hidden></p></div>`;
    const list = host.querySelector('#priority-candidates');
    const addButton = host.querySelector('#priority-add-candidate');
    const roleById = new Map(roles.map(role=>[role.id,role]));
    const formatPercent = new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1});
    const read = () => [...list.children].map(row => ({
      roleId:row.querySelector('select').value, tier:row.querySelector('.priority-tier-input').valueAsNumber,
      weight:row.querySelector('.priority-weight-input').valueAsNumber,
    }));
    function refresh() {
      const candidates = read();
      const selected = new Set(candidates.map(item=>item.roleId));
      const available = item => {
        const role = roleById.get(item.roleId);
        return role && role.enabled !== false && role.engine !== 'gemini-web' &&
          [item.tier,item.weight].every(value => Number.isInteger(value) && value >= 1 && value <= 100);
      };
      const totals = new Map();
      for (const item of candidates.filter(available)) totals.set(item.tier,(totals.get(item.tier)||0)+item.weight);
      [...list.children].forEach((row,index) => {
        const item = candidates[index], select = row.querySelector('select');
        const current = roleById.get(item.roleId);
        select.innerHTML = (current ? '' : option(item.roleId,'已移除角色',item.roleId)) +
          roles.filter(role=>role.id===item.roleId||!selected.has(role.id)).map(role=>
            option(role.id,role.name + (role.enabled===false?'（已禁用）':''),item.roleId)).join('');
        row.querySelector('output').textContent = available(item) ? formatPercent.format(item.weight/totals.get(item.tier)) : '—';
      });
      addButton.disabled = candidates.length >= 100 || !roles.some(role=>!selected.has(role.id));
    }
    function add(item) {
      const row = document.createElement('div');
      row.className = 'priority-candidate';
      row.innerHTML = `<select aria-label="候选角色">${option(item.roleId,item.roleId,item.roleId)}</select>
        <input type="number" class="priority-tier-input" aria-label="优先档位" min="1" max="100" step="1" value="${item.tier}" required>
        <input type="number" class="priority-weight-input" aria-label="抽选权重" min="1" max="100" step="1" value="${item.weight}" required>
        <output aria-label="同档抽选比例"></output><button type="button" class="quiet" aria-label="移除候选角色">移除</button>`;
      row.querySelector('button').onclick = () => { row.remove(); refresh(); };
      list.append(row);
      return row;
    }
    addButton.onclick = () => {
      const selected = new Set(read().map(item=>item.roleId));
      const next = roles.find(role=>!selected.has(role.id));
      if (!next) return;
      const row = add({roleId:next.id,tier:1,weight:1});
      refresh();
      row.querySelector('select').focus();
    };
    if (rule) {
      rule.candidates.forEach(add);
      host.querySelector('#priority-delete').onclick = remove;
    } else if (roles.length) add({roleId:roles[0].id,tier:1,weight:1});
    list.addEventListener('change', event => { if (event.target.matches('select')) refresh(); });
    list.addEventListener('input', event => { if (event.target.matches('input')) refresh(); });
    refresh();
    return () => ({ domain:host.querySelector('#priority-domain').value, duty:host.querySelector('#priority-duty').value, candidates:read() });
  }

  function editPlan(host, nodes, roles, rules, locked = 0, priorityRoles = roles) {
    host.innerHTML = suggestions('workflow-node',ratings.catalog(rules));
    const readNodes = nodes.map((node,index) => {
      const card = document.createElement('section');
      card.className = 'setting-card workflow-node';
      const disabled = index < locked ? 'disabled' : '';
      card.innerHTML = `<h3>步骤 ${index+1}${disabled?' · 已完成':''}</h3><label>名称<input class="node-title" value="${escape(node.title)}" maxlength="100" required ${disabled}></label><label>任务与完成条件<textarea class="node-instruction" maxlength="4000" rows="3" required ${disabled}>${escape(node.instruction)}</textarea></label><div class="workflow-node-ratings"><label>场景<input class="node-domain" list="workflow-node-domains" value="${escape(node.domain)}" maxlength="40" required ${disabled}></label><label>职责<input class="node-duty" list="workflow-node-duties" value="${escape(node.duty)}" maxlength="40" required ${disabled}></label></div><label>选人方式<select class="node-mode" ${disabled}>${option('auto','自动选人',node.mode)}${option('ordered','指定名单',node.mode)}</select></label><p class="node-recommendation hint"></p><div class="node-candidates"></div>`;
      host.append(card);
      let reworkSelect;
      if (index > 0) {
        const label = document.createElement('label');
        label.textContent = '发现问题时';
        reworkSelect = document.createElement('select');
        reworkSelect.className = 'node-rework';
        reworkSelect.disabled = Boolean(disabled);
        reworkSelect.innerHTML = option('', '暂停并等待确认', node.reworkTo ?? '') +
          nodes.slice(0,index).map((target,i) => option(i+1, `返回步骤 ${i+1} · ${target.title}`, node.reworkTo)).join('');
        label.append(reworkSelect);
        card.append(label);
      }
      const fields = Object.fromEntries(['title','instruction','domain','duty','mode'].map(key=>[key,card.querySelector(`.node-${key}`)]));
      const group = card.querySelector('.node-candidates');
      const recommendation = card.querySelector('.node-recommendation');
      let selected = [...(node.roleIds || [])];
      function refresh() {
        const auto = fields.mode.value === 'auto';
        group.hidden = auto;
        recommendation.hidden = !auto;
        group.replaceChildren();
        const rule = ratings.findRule(rules,{domain:fields.domain.value,duty:fields.duty.value});
        const eligible = rule?.candidates.filter(item=>priorityRoles.some(role=>role.id===item.roleId)) || [];
        const first = ratings.tiers(eligible)[0];
        if (auto) {
          recommendation.textContent = first ? `匹配优先级表 · 第 ${first[0]} 档 · ` +
            first[1].map(item=>`${priorityRoles.find(role=>role.id===item.roleId).name} ×${item.weight}`).join('、') :
            rule ? '已匹配优先级表，但此项目当前没有可运行的规则候选。' : '暂无匹配规则。可由主持人选人，也可以指定名单。';
          return;
        }
        if (!selected.length) selected = roles.slice(0,1).map(role=>role.id);
        selected.forEach((id,position)=>{
          const row = document.createElement('div');
          row.className = 'group-order-row';
          const choices = roles.filter(role=>role.id===id||!selected.includes(role.id));
          row.innerHTML = `<select aria-label="候选角色 ${position+1}" ${disabled}>${choices.some(role=>role.id===id)?'':option(id,'角色已不可用',id)}${choices.map(role=>option(role.id,role.name,id)).join('')}</select><button type="button" aria-label="上移候选角色">↑</button><button type="button" aria-label="下移候选角色">↓</button><button type="button" aria-label="移除候选角色">移除</button>`;
          group.append(row);
          const select = row.querySelector('select');
          select.onchange = () => { selected[position]=select.value; refresh(); };
          const buttons = row.querySelectorAll('button');
          for (const [button,offset] of [[buttons[0],-1],[buttons[1],1]]) {
            const destination = position+offset;
            button.disabled = Boolean(disabled) || destination<0 || destination>=selected.length;
            button.onclick = () => { [selected[position],selected[destination]]=[selected[destination],selected[position]]; refresh(); };
          }
          buttons[2].disabled = Boolean(disabled) || selected.length===1;
          buttons[2].onclick = () => { selected.splice(position,1); refresh(); };
        });
        const add = document.createElement('button');
        add.type = 'button'; add.textContent = '添加候选角色';
        const next = roles.find(role=>!selected.includes(role.id));
        add.disabled = Boolean(disabled) || !next;
        add.onclick = () => { selected.push(next.id); refresh(); };
        group.append(add);
      }
      fields.mode.onchange = fields.domain.oninput = fields.duty.oninput = refresh;
      refresh();
      return () => ({...Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.value])),
        ...(reworkSelect?.value ? {reworkTo:Number(reworkSelect.value)} : {}),
        ...(fields.mode.value==='ordered'?{roleIds:[...selected]}:{})});
    });
    return () => readNodes.map(read=>read());
  }

  window.deskWorkflowUI = {priorityView,editPriority,editPlan};
})();
