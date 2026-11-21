(() => {
  const ratings = window.deskWorkflowRatings;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const option = (value, name, selected) => `<option value="${escape(value)}" ${value===selected?'selected':''}>${escape(name)}</option>`;

  function suggestions(prefix, catalog) {
    return `<datalist id="${prefix}-domains">${catalog.domains.map(name=>option(name,name)).join('')}</datalist><datalist id="${prefix}-duties">${catalog.duties.map(name=>option(name,name)).join('')}</datalist>`;
  }

  function editRatings(host, values, catalog) {
    host.innerHTML = `<summary>工作流评分 <small>可选设置</small></summary><p class="hint">给这个角色的领域和职责组合打 1–10 分。可以输入自定义名称。未添加的组合视为未评分。</p><div id="rating-rows"></div><button type="button" id="rating-add">添加评分</button>${suggestions('role-rating',catalog)}`;
    const rows = host.querySelector('#rating-rows');
    function add(value = {}) {
      const row = document.createElement('div');
      row.className = 'workflow-rating-row';
      row.innerHTML = `<label>领域<input class="rating-domain" list="role-rating-domains" value="${escape(value.domain)}" maxlength="40"></label><label>职责<input class="rating-duty" list="role-rating-duties" value="${escape(value.duty)}" maxlength="40"></label><label>分数<input class="rating-score" type="number" min="1" max="10" step="1" value="${escape(value.score)}"></label><button type="button" aria-label="移除此项评分">移除</button>`;
      row.querySelector('button').onclick = () => row.remove();
      rows.append(row);
      return row;
    }
    values.forEach(add);
    host.querySelector('#rating-add').onclick = () => {
      if (rows.children.length < 80) add().querySelector('input').focus();
    };
    return () => Array.from(rows.children, row => {
      const domain = row.querySelector('.rating-domain').value.trim();
      const duty = row.querySelector('.rating-duty').value.trim();
      const score = row.querySelector('.rating-score').value;
      return domain || duty || score ? {domain,duty,score:Number(score)} : null;
    }).filter(Boolean);
  }

  function editPlan(host, nodes, roles, catalog, locked = 0) {
    host.innerHTML = suggestions('workflow-node',catalog);
    const readNodes = nodes.map((node,index) => {
      const card = document.createElement('section');
      card.className = 'setting-card workflow-node';
      const disabled = index < locked ? 'disabled' : '';
      card.innerHTML = `<h3>步骤 ${index+1}${disabled?' · 已完成':''}</h3><label>名称<input class="node-title" value="${escape(node.title)}" maxlength="100" required ${disabled}></label><label>任务与完成条件<textarea class="node-instruction" maxlength="4000" rows="3" required ${disabled}>${escape(node.instruction)}</textarea></label><div class="workflow-node-ratings"><label>领域<input class="node-domain" list="workflow-node-domains" value="${escape(node.domain)}" maxlength="40" required ${disabled}></label><label>职责<input class="node-duty" list="workflow-node-duties" value="${escape(node.duty)}" maxlength="40" required ${disabled}></label></div><label>选人方式<select class="node-mode" ${disabled}>${option('auto','自动选人',node.mode)}${option('ordered','指定名单',node.mode)}</select></label><p class="node-recommendation hint"></p><div class="node-candidates"></div>`;
      host.append(card);
      const fields = Object.fromEntries(['title','instruction','domain','duty','mode'].map(key=>[key,card.querySelector(`.node-${key}`)]));
      const group = card.querySelector('.node-candidates');
      const recommendation = card.querySelector('.node-recommendation');
      let selected = [...(node.roleIds || [])];
      const ranked = () => ratings.rank({domain:ratings.label(fields.domain.value),duty:ratings.label(fields.duty.value)},roles).filter(item=>item.score!==null).slice(0,3);
      function refresh() {
        const auto = fields.mode.value === 'auto';
        group.hidden = auto;
        recommendation.hidden = !auto;
        group.replaceChildren();
        const picks = ranked();
        if (auto) {
          recommendation.textContent = picks.length ? '当前推荐 · '+picks.map(item=>`${roles.find(role=>role.id===item.roleId)?.name} ${item.score} 分`).join('、') : '暂无匹配评分。可由主持人选人，也可以指定名单。';
          return;
        }
        if (!selected.length) selected = picks.length ? picks.map(item=>item.roleId) : roles.slice(0,1).map(role=>role.id);
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
      return () => ({...Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.value])),...(fields.mode.value==='ordered'?{roleIds:[...selected]}:{})});
    });
    return () => readNodes.map(read=>read());
  }

  window.deskWorkflowUI = {editRatings,editPlan};
})();
