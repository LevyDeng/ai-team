(() => {
  const names = { codex: 'Codex CLI', antigravity: 'Antigravity', kimi: 'Kimi Code', codebuddy: 'CodeBuddy Code' };
  const statuses = {
    check_failed: '检查失败，请确认网络、代理和托管目录后重试。',
    install_failed: '更新失败，请检查网络、Node.js 和目录权限后重新检查。',
    installed: '已安装，之后启动的任务将使用此版本。',
  };
  function batchStatus(state) {
    if (state.batch === 'check') return '正在检查已启用的 CLI…';
    if (state.batch === 'install') return '正在更新可用项…';
    const result = state.batchResult;
    if (!result) return '';
    const counts = result.operation === 'check' ? [[result.checked, '项已检查']] : [[result.installed, '项已更新']];
    counts.push([result.started, '项服务器更新已启动'], [result.skipped, '项已跳过'], [result.failed, '项失败']);
    return counts.filter(([count]) => count).map(([count, label]) => count + ' ' + label).join('，') ||
      (result.operation === 'check' ? '没有符合条件的 CLI 可检查。' : '没有符合条件的 CLI 可更新。');
  }

  window.createCliUpdatesView = (container, { request, error }) => {
    container.innerHTML = `
      <section class="setting-card" aria-labelledby="cli-preferences-title">
        <h3 id="cli-preferences-title">更新偏好</h3>
        <div class="checks cli-update-preferences">
          <label><input type="checkbox" data-cli-preference="autoCheck">启动时在后台检查更新</label>
          <label><input type="checkbox" data-cli-preference="reminders">显示可用更新提醒</label>
        </div>
        <p>启动时检查启用角色正在使用的本机托管 CLI，每 12 小时最多成功检查一次。服务器 Claude Code 可手动检查。</p>
      </section>
      <section class="setting-card" aria-labelledby="cli-managed-title">
        <h3 id="cli-managed-title">托管 CLI</h3>
        <p>批量检查和更新仅包含启用角色正在使用的托管 CLI。更新时跳过有任务或终端占用的本机 CLI。</p>
        <div class="cli-update-actions">
          <button type="button" data-cli-action="check">检查全部更新</button>
          <button type="button" data-cli-action="install" class="primary">更新全部可用项</button>
        </div>
        <p class="cli-update-notice" role="status" hidden></p>
        <p class="cli-update-batch-status" role="status" hidden></p>
        <div class="cli-update-rows"></div>
      </section>`;
    const find = selector => container.querySelector(selector);
    const preferences = [...container.querySelectorAll('[data-cli-preference]')];
    const rows = new Map();
    const saving = new Set();
    let state = {};
    const run = async (verb, id) => {
      try { await (id ? request(verb, id) : request(verb)); }
      catch (problem) { error(problem); }
    };

    for (const input of preferences) input.onchange = async () => {
      const key = input.dataset.cliPreference;
      saving.add(key);
      input.disabled = true;
      try { await request('preference', key, input.checked); }
      catch (problem) { error(problem); }
      finally { saving.delete(key); render(state); }
    };
    for (const button of container.querySelectorAll('[data-cli-action]')) button.onclick = () => run(button.dataset.cliAction);

    function addRow(engine) {
      const element = document.createElement('section');
      element.className = 'cli-update-row';
      element.innerHTML = `<div><h4>${names[engine]} <span class="hint">· 本机</span></h4>
        <p class="cli-update-versions"></p><p class="cli-update-source"></p><p class="cli-update-status" role="status"></p>
        </div><div class="cli-update-actions">
          <button type="button" class="cli-check">检查</button><button type="button" class="cli-install">更新</button>
        </div>`;
      const get = selector => element.querySelector(selector);
      const row = {
        versions: get('.cli-update-versions'), source: get('.cli-update-source'), status: get('.cli-update-status'),
        check: get('.cli-check'), install: get('.cli-install'),
      };
      row.check.setAttribute('aria-label', '检查 ' + names[engine] + ' 更新');
      row.check.onclick = () => run('check', engine);
      row.install.onclick = () => run('install', engine);
      find('.cli-update-rows').append(element);
      rows.set(engine, row);
      return row;
    }

    function render(next) {
      state = next || {};
      for (const input of preferences) {
        const key = input.dataset.cliPreference;
        input.disabled = saving.has(key) || !next;
        if (!saving.has(key)) input.checked = state[key] !== false;
      }
      const notice = find('.cli-update-notice');
      const count = state.reminders && state.count;
      notice.textContent = count ? count + ' 个 CLI 有可用更新。' : '';
      notice.hidden = !count;
      const summary = find('.cli-update-batch-status');
      summary.textContent = batchStatus(state);
      summary.hidden = !summary.textContent;
      find('[data-cli-action="check"]').disabled = Boolean(state.batch) || !state.canCheckAll;
      find('[data-cli-action="install"]').disabled = Boolean(state.batch) || !state.count;
      for (const item of state.rows || []) {
        if (!Object.hasOwn(names, item.engine)) continue;
        const row = rows.get(item.engine) || addRow(item.engine);
        row.versions.textContent = '托管版本 ' + (item.installed || (item.managed ? '待检查' : '未安装')) + ' · 最新版 ' + (item.latest || '待检查');
        row.source.textContent = item.roleCount ? item.usingManaged + ' / ' + item.roleCount + ' 个启用角色使用托管版本' : '暂无启用角色';
        if (item.external) row.source.textContent += ' · ' + item.external + ' 个角色关联外部路径';
        if (item.managed) row.versions.title = item.managed;
        else row.versions.removeAttribute('title');
        row.status.textContent = item.pending === 'checking' ? '正在检查…' : item.pending === 'installing' ? '正在安装…' :
          item.blockers.length ? '占用中 · ' + item.blockers.join('、') :
          statuses[item.status] || (item.available ? '有新版本可用。' :
            item.latest && !item.managed ? '可以安装托管版本。' :
            item.installed && item.latest ? (item.installed === item.latest ? '已是最新版。' : '当前版本无需更新。') : '');
        row.status.hidden = !row.status.textContent;
        row.check.disabled = Boolean(item.pending);
        row.install.disabled = Boolean(state.batch || item.pending || item.blockers.length || (item.managed ? !item.available : !item.latest));
        row.install.textContent = item.managed ? '更新' : '安装';
        row.install.setAttribute('aria-label', row.install.textContent + ' ' + names[item.engine]);
      }
    }

    return { render };
  };
})();
