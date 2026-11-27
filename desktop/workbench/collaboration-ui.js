(() => {
  const collaboration = window.deskCollaboration;
  const sources = {global:'全局', project:'项目', chat:'本会话'};

  function policyEditor(host, scope, settings, project, chat) {
    const local = {global:settings, project, chat}[scope]?.aiInvites || {};
    const inherit = scope === 'global' ? '' : '<option value="">继承上一级</option>';
    host.innerHTML = `<div class="collaboration-fields">
      <label>允许 AI 邀请其他成员<select data-invite-enabled>${inherit}<option value="false">禁止</option><option value="true">允许</option></select></label>
      <label>每条用户消息的邀请上限<select data-invite-limit>${inherit}${Array.from({length: collaboration.maxInvites}, (_, i) => `<option value="${i+1}">${i+1} 次</option>`).join('')}</select></label>
    </div><p class="collaboration-effective hint" aria-live="polite"></p><p class="hint">自动运行的群聊成员共享次数。每次邀请增加一条协作回复。</p>`;
    const enabled = host.querySelector('[data-invite-enabled]');
    const limit = host.querySelector('[data-invite-limit]');
    enabled.value = String(local.allowed ?? (scope === 'global' ? false : ''));
    limit.value = String(local.limit ?? (scope === 'global' ? 2 : ''));
    const read = () => ({...(enabled.value && {allowed: enabled.value === 'true'}), ...(limit.value && {limit: Number(limit.value)})});
    function refresh() {
      const draft = {aiInvites: read()};
      const effective = collaboration.policy(scope === 'global' ? draft : settings, scope === 'project' ? draft : project, scope === 'chat' ? draft : chat);
      const source = entry => entry.source === scope ? '本层设置' : `继承自${sources[entry.source]}`;
      host.querySelector('.collaboration-effective').textContent = `当前生效 · ${effective.allowed.value ? '允许' : '禁止'}（${source(effective.allowed)}） · 每条消息最多 ${effective.limit.value} 次（${source(effective.limit)}）`;
    }
    enabled.onchange = limit.onchange = refresh;
    refresh();
    return read;
  }

  function dutyEditor(host, {scope, parent, value, role, onChange = () => {}}) {
    const inherited = scope !== 'global';
    const localLabel = scope === 'project' ? '本项目' : '本会话';
    host.innerHTML = `<div class="duty-source" ${inherited ? '' : 'hidden'}><span class="hint"></span><button type="button" class="quiet"></button></div>
      <p class="duty-inherited" hidden></p>
      <div class="duty-input"><label>${inherited ? '分工' : '默认分工'}<textarea rows="3" maxlength="${collaboration.dutyLimit}" placeholder="例如，负责网页操作，复现问题并截图。"></textarea></label>
      <div class="duty-input-footer"><div class="duty-templates"><button type="button" class="quiet">网页操作</button><button type="button" class="quiet">代码审查</button><button type="button" class="quiet">资料整理</button></div><span class="hint duty-count"></span></div></div>
      ${role?.engine === 'slack-chat' ? '<p class="hint">Slack 私信角色只接收用户输入的正文。</p>' : ''}`;
    const text = host.querySelector('textarea');
    const source = host.querySelector('.duty-source span');
    const toggle = host.querySelector('.duty-source button');
    const input = host.querySelector('.duty-input');
    const overview = host.querySelector('.duty-inherited');
    const templates = host.querySelector('.duty-templates');
    const count = host.querySelector('.duty-count');
    let override = !inherited || typeof value === 'string';
    text.value = value ?? parent?.value ?? '';
    function refreshInput() {
      count.textContent = `${text.value.length} / ${collaboration.dutyLimit}`;
      templates.hidden = Boolean(text.value.trim());
    }
    function refresh() {
      input.hidden = !override;
      overview.hidden = override;
      overview.textContent = parent?.value || '尚未设置分工';
      source.textContent = override ? `${localLabel}已覆盖` : `继承自${sources[parent?.source || 'global']}`;
      toggle.textContent = override ? '恢复继承' : `为${localLabel}自定义`;
      refreshInput();
    }
    const read = () => override ? text.value.trim() : null;
    toggle.onclick = () => {
      override = !override;
      text.value = parent?.value ?? '';
      refresh();
      onChange(read());
      if (override) text.focus();
    };
    text.oninput = () => { refreshInput(); onChange(read()); };
    const examples = ['负责网页操作，复现问题并截图。遇到登录时请用户接手。',
      '审查代码改动，列出可能的回归、复现条件和需要补充的验证。', '收集并核对资料，整理结论和出处。'];
    [...templates.querySelectorAll('button')].forEach((button, i) => {
      button.onclick = () => { text.value = examples[i]; refreshInput(); onChange(read()); text.focus(); };
    });
    refresh();
    return read;
  }

  window.deskCollaborationUI = {policyEditor, dutyEditor};
})();
