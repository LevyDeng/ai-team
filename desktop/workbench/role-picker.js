(() => {
  function createRolePicker(container, { roles, selected = [], projectRoleIds = [], locationName, onChange }) {
    const available = new Map(roles.map(role => [role.id, role]));
    const chosen = new Set(selected.filter(id => available.has(id)));
    const members = new Set(projectRoleIds);
    container.className = 'role-picker';
    container.innerHTML = '<div class="role-picker-selection"><span class="role-picker-count" aria-live="polite"></span><button type="button" class="quiet role-picker-clear">清空</button></div><div class="role-picker-chips"></div><label class="search role-picker-search"><img src="icons/search.svg" alt=""><input type="search" placeholder="搜索角色名称、简介或模型" aria-label="搜索可选角色"></label><div class="role-picker-list" role="group" aria-label="可选角色"></div><p class="role-picker-empty" hidden>没有找到匹配的角色，换个关键词试试。</p>';
    const list = container.querySelector('.role-picker-list');
    const chips = container.querySelector('.role-picker-chips');
    const rows = [];
    const engines = { codex: 'Codex CLI', claude: 'Claude Code', opencode: 'OpenCode', kimi:'Kimi Code', cursor:'Cursor Agent', workbuddy:'WorkBuddy', codebuddy:'CodeBuddy Code', antigravity:'Antigravity', 'custom-acp':'自定义 ACP' };
    function portrait(role) {
      const element = document.createElement('span');
      element.className = 'avatar a' + (Number(role.avatar) || 0);
      if (role.avatarUrl) {
        element.classList.add('custom');
        const image = document.createElement('img'); image.src = role.avatarUrl; image.alt = ''; element.append(image);
      }
      element.setAttribute('aria-hidden', 'true');
      return element;
    }
    function refresh() {
      container.querySelector('.role-picker-count').textContent = `已选 ${chosen.size} 位 · 共 ${roles.length} 个角色`;
      container.querySelector('.role-picker-clear').disabled = chosen.size === 0;
      chips.replaceChildren();
      if (!chosen.size) {
        const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = '从下方选择参与这次对话的角色'; chips.append(empty);
      }
      for (const id of chosen) {
        const role = available.get(id); const button = document.createElement('button');
        button.type = 'button'; button.className = 'role-picker-chip'; button.setAttribute('aria-label', '移除' + role.name);
        const name = document.createElement('span'); name.textContent = role.name;
        const remove = document.createElement('img'); remove.src = 'icons/x.svg'; remove.alt = '';
        button.append(portrait(role), name, remove);
        button.onclick = () => { chosen.delete(id); refresh(); };
        chips.append(button);
      }
      for (const row of rows) { row.input.checked = chosen.has(row.role.id); row.element.classList.toggle('selected', row.input.checked); }
      onChange?.([...chosen]);
    }
    const orderedRoles = roles.toSorted((a,b) => Number(members.has(b.id)) - Number(members.has(a.id)));
    for (const role of orderedRoles) {
      const element = document.createElement('label'); element.className = 'role-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = role.id; input.setAttribute('aria-label', role.name);
      input.onchange = () => { input.checked ? chosen.add(role.id) : chosen.delete(role.id); refresh(); };
      const info = document.createElement('span'); info.className = 'role-option-info';
      const name = document.createElement('strong'); name.textContent = role.name;
      const description = document.createElement('span'); description.className = 'role-option-description';
      description.textContent = [engines[role.engine] || role.engine, role.provider === 'native' ? '原生账号' : role.provider, locationName?.(role.locationId), role.model || '默认模型'].filter(Boolean).join(' · ');
      description.title = description.textContent;
      info.append(name, description);
      const membership = document.createElement('span'); membership.className = 'role-option-membership'; membership.textContent = role.enabled === false ? '已禁用' : members.has(role.id) ? '项目成员' : '可添加';
      element.append(input, portrait(role), info, membership); list.append(element); rows.push({ element, input, role });
    }
    container.querySelector('input[type=search]').oninput = event => {
      const query = event.target.value.trim().toLocaleLowerCase(); let visible = 0;
      for (const row of rows) {
        const match = [row.role.name, row.role.description, row.role.model, row.role.provider, row.role.engine, locationName?.(row.role.locationId)].join('\n').toLocaleLowerCase().includes(query);
        row.element.hidden = !match; if (match) visible++;
      }
      container.querySelector('.role-picker-empty').hidden = visible !== 0;
      list.hidden = visible === 0;
    };
    container.querySelector('.role-picker-clear').onclick = () => { chosen.clear(); refresh(); };
    refresh(); return { selected: () => [...chosen] };
  }
  window.createRolePicker = createRolePicker;
})();
