(() => {
  window.createModelPicker = (container, { value, load, onCatalog = () => {} }) => {
    const abort = new AbortController(); let models = [], query = '', selected = 0, version = 0, busy = false;
    container.className = 'model-picker';
    container.innerHTML = '<div class="model-picker-input"><input id="r-model" placeholder="选择或输入模型 ID" autocomplete="off" aria-label="模型 ID" aria-autocomplete="list" aria-controls="role-model-options"><button type="button" class="model-picker-toggle" aria-label="选择模型">选择</button></div><div class="model-picker-meta"><small class="hint model-picker-status" role="status">可选择模型或直接输入 ID</small><button type="button" class="quiet model-picker-refresh">刷新列表</button></div><div class="model-picker-menu" hidden><div id="role-model-options" role="listbox" aria-label="可选模型"></div></div>';
    const input = container.querySelector('input'); input.value = value || '';
    const menu = container.querySelector('.model-picker-menu'), list = container.querySelector('[role=listbox]'), status = container.querySelector('.model-picker-status'), refresh = container.querySelector('.model-picker-refresh');
    let visible = [];
    const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    function highlight() {
      const options = [...list.querySelectorAll('[role=option]')];
      for (const [index, button] of options.entries()) button.setAttribute('aria-selected', String(index === selected));
      const option = options[selected]; if (option) { input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    }
    function choose(index) { const model = visible[index]; if (!model) return; input.value = model.id; query = ''; input.focus(); close(); input.dispatchEvent(new Event('change', { bubbles: true })); }
    function render() {
      visible = models.filter(model => [model.id, model.label, model.description].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      selected = Math.min(selected, Math.max(0, visible.length - 1)); list.replaceChildren();
      for (const [index, model] of visible.entries()) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'model-picker-option'; button.id = 'role-model-option-' + index; button.setAttribute('role', 'option'); button.dataset.modelId = model.id;
        const name = document.createElement('strong'); name.textContent = model.label || model.id;
        const detail = document.createElement('small'); detail.textContent = model.id; button.append(name, detail);
        button.onpointerdown = event => event.preventDefault(); button.onclick = () => choose(index); list.append(button);
      }
      if (!visible.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = busy ? '正在读取模型列表…' : models.length ? '没有匹配项，可直接输入模型 ID' : '暂无列表，可刷新或手动输入模型 ID'; list.append(empty); }
      if (!menu.hidden) highlight();
    }
    async function update(force = false) {
      const request = ++version; busy = true; refresh.disabled = true; status.textContent = '正在读取模型列表…'; render();
      try {
        const result = await load(force);
        if (request !== version || !container.isConnected) return;
        models = result.models || []; status.textContent = (result.warning ? '刷新失败，保留缓存 · ' : result.cached ? '缓存 · ' : '已更新 · ') + models.length + ' 个模型 · ' + new Date(result.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        onCatalog(models);
        status.title = result.warning || '可用模型取决于账号权限。';
      } catch (error) {
        if (request !== version || !container.isConnected) return;
        status.textContent = /Enter an API key/.test(error.message) ? '请先填写 API Key，再刷新列表；无需先保存角色' : /Configure a system or custom proxy/.test(error.message) ? '请先在所在位置配置代理，再刷新列表' : /proxy|network connection/.test(error.message) ? '无法连接模型服务，请检查位置代理或网络后刷新' : /HTTP 401/.test(error.message) ? 'API Key 无效，请检查后刷新' : /HTTP 403/.test(error.message) ? '服务拒绝请求（403），请检查 Key 权限和网络出口' : /HTTP 429/.test(error.message) ? '请求过于频繁，请稍后刷新列表' : /timed out/.test(error.message) ? '读取列表超时，可手动输入或稍后刷新' : models.length ? '读取失败，保留已有列表；可以重试或手动输入' : '列表暂不可用，可刷新或手动输入'; status.title = error.message;
      } finally { if (request === version) { busy = false; refresh.disabled = false; render(); } }
    }
    function open() { query = ''; selected = Math.max(0, models.findIndex(model => model.id === input.value)); menu.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); }
    input.addEventListener('focus', open);
    input.addEventListener('input', () => { query = input.value; selected = 0; menu.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || menu.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (visible.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length; highlight(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (visible.length) choose(selected); else close(); }
    });
    input.addEventListener('blur', close);
    container.querySelector('.model-picker-toggle').onclick = () => { if (menu.hidden) open(); else close(); };
    refresh.onclick = () => update(true);
    document.addEventListener('pointerdown', event => { if (!container.contains(event.target)) close(); }, { signal: abort.signal });
    close(); render();
    return { update, reset() { ++version; models = []; onCatalog(models); busy = false; refresh.disabled = false; status.textContent = '连接配置已变化，正在重新读取…'; close(); render(); }, destroy() { ++version; abort.abort(); close(); } };
  };
})();
