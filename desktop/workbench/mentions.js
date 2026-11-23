/* Plain-text mentions keep routing with the draft across navigation and restarts. */
((root) => {
  const boundary = character => !character || /\s/u.test(character) || '([{，,:：;；。！？!?"'.includes(character);
  const ending = character => boundary(character) || ')]}、'.includes(character);
  const prose = text => text.replace(/(`+)[\s\S]*?\1/g, match => ' '.repeat(match.length));
  function projectGuestIds(chat, project) {
    if (!chat || !project || chat.projectId !== project.id || chat.roleIds.length < 2 || chat.disbandedAt || chat.workflow) return [];
    const members = new Set(chat.roleIds);
    return project.roleIds.filter(id => !members.has(id));
  }
  function choices(roles) {
    const used = new Set(['所有角色', '所有人']);
    const entries = roles.map(role => {
      let label = role.name, suffix = 2;
      while (used.has(label)) label = role.name + '（' + suffix++ + '）';
      used.add(label); return { ...role, label };
    });
    return roles.filter(role => !role.guest).length > 1 ? [{ id: 'all', name: '所有角色', label: '所有角色' }, ...entries] : entries;
  }
  function resolve(text, roles, defaultReplyRoleIds) {
    const source = prose(text), matches = [];
    const members = roles.filter(role => !role.guest && role.enabled !== false);
    const entries = choices(roles);
    if (entries[0]?.id === 'all') entries.push({ id: 'all', label: '所有人' });
    entries.sort((a,b) => b.label.length - a.label.length);
    for (let position = source.indexOf('@'); position >= 0; position = source.indexOf('@', position + 1)) {
      if (!boundary(source[position - 1])) continue;
      const entry = entries.find(item => source.startsWith('@' + item.label, position) && ending(source[position + item.label.length + 1]));
      if (entry) matches.push({ entry, start: position, end: position + entry.label.length + 1 });
    }
    let roleIds = [];
    const explicitIds = new Set(), disabled = new Set(), blockedGuests = new Set();
    if (!matches.length) {
      const defaults = new Set(Array.isArray(defaultReplyRoleIds) ? defaultReplyRoleIds : []);
      roleIds = members.filter(role => defaults.has(role.id)).map(role => role.id);
      if (!roleIds.length) roleIds = members.map(role => role.id);
    }
    for (const {entry} of matches) {
      const id = entry.id;
      if (id === 'all') { for (const role of members) if (!roleIds.includes(role.id)) roleIds.push(role.id); }
      else if (entry.mentionAllowed === false) blockedGuests.add(id);
      else if (entry.enabled === false) disabled.add(id);
      else if (!explicitIds.has(id)) { explicitIds.add(id); roleIds = roleIds.filter(value => value !== id); roleIds.push(id); }
    }
    let content = text;
    for (const match of [...matches].reverse()) content = content.slice(0, match.start) + content.slice(match.end);
    return { roleIds, content: content.trim(), explicit: Boolean(matches.length),
      ...(disabled.size ? { disabledRoleIds: [...disabled] } : {}),
      ...(blockedGuests.size ? { blockedGuestIds: [...blockedGuests] } : {}) };
  }
  function createMentionComposer(input, menu, { roles, portrait, changed }) {
    let entries = [], selected = 0, context, dismissed = '', composing = false;
    input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-autocomplete', 'list');
    function close() { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); context = null; }
    function active() {
      const caret = input.selectionStart;
      if (caret !== input.selectionEnd) return null;
      const start = input.value.lastIndexOf('@', caret - 1);
      if (start < 0 || !boundary(input.value[start - 1]) || prose(input.value)[start] !== '@') return null;
      const query = input.value.slice(start + 1, caret);
      if (query.length > 60 || /[\r\n]/.test(query)) return null;
      return { start, end: caret, query, key: start + ':' + query };
    }
    function highlight() {
      for (const [index, element] of [...menu.querySelectorAll('[role=option]')].entries()) element.setAttribute('aria-selected', String(index === selected));
      const element = menu.querySelectorAll('[role=option]')[selected];
      if (element) { input.setAttribute('aria-activedescendant', element.id); element.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function choose(index) {
      const entry = entries[index]; if (!entry || !context) return;
      input.setRangeText('@' + entry.label + ' ', context.start, context.end, 'end');
      dismissed = ''; close(); input.focus(); changed();
    }
    function update(reset = false) {
      if (reset) dismissed = '';
      if (composing) { close(); return; }
      const next = active();
      if (!next || next.key === dismissed) { close(); return; }
      const roster = roles();
      const activeCount = roster.filter(role => !role.guest && role.enabled !== false).length;
      entries = choices(roster).filter(entry => (entry.id === 'all' ? activeCount > 1 : entry.enabled !== false && entry.mentionAllowed !== false) && entry.label.toLocaleLowerCase().includes(next.query.toLocaleLowerCase()));
      if (!entries.length && /\s/.test(next.query)) { close(); return; }
      const keyChanged = context?.key !== next.key; context = next;
      if (keyChanged || selected >= entries.length) selected = 0;
      menu.replaceChildren();
      const header = document.createElement('div'); header.className = 'mention-heading'; header.textContent = '选择发言角色'; menu.append(header);
      for (const [index, entry] of entries.entries()) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'mention-option'; button.id = 'mention-option-' + index; button.setAttribute('role', 'option');
        button.classList.toggle('mention-guest', Boolean(entry.guest));
        const image = document.createElement('span'); image.innerHTML = portrait(entry);
        const info = document.createElement('span'); info.className = 'mention-info';
        const label = document.createElement('strong'); label.textContent = '@' + entry.label;
        const detail = document.createElement('small'); detail.textContent = entry.id === 'all' ? '让本对话中已启用的角色依次发言' : [entry.guest && '项目角色 · 未加入群聊', entry.engine === 'codex' ? 'Codex CLI' : entry.engine === 'claude' ? 'Claude Code' : entry.engine, entry.provider === 'native' ? '原生账号' : entry.provider, entry.model].filter(Boolean).join(' · ');
        info.append(label, detail); button.append(image, info);
        button.onpointerdown = event => event.preventDefault(); button.onclick = () => choose(index); menu.append(button);
      }
      if (!entries.length) { const empty = document.createElement('p'); empty.className = 'mention-empty'; empty.textContent = '没有匹配的可点名角色'; menu.append(empty); }
      menu.hidden = false; input.setAttribute('aria-expanded', 'true'); highlight();
    }
    function keydown(event) {
      if (event.isComposing || composing || event.keyCode === 229 || menu.hidden) return false;
      if (event.key === 'Escape') { dismissed = context?.key || ''; close(); return true; }
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) { close(); return false; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { if (entries.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; highlight(); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { if (entries.length) choose(selected); else close(); return true; }
      return false;
    }
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; update(true); });
    input.addEventListener('click', () => update());
    input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update(); });
    input.addEventListener('blur', close);
    document.addEventListener('pointerdown', event => { if (event.target !== input && !menu.contains(event.target)) close(); });
    close(); return { update, close, keydown };
  }
  if (typeof module !== 'undefined') module.exports = { choices, resolve, projectGuestIds };
  root.deskMentions = { choices, resolve, projectGuestIds, create: createMentionComposer };
})(typeof window === 'undefined' ? globalThis : window);
