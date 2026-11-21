(() => {
  function createQuotaPanel(container, { refresh, error }) {
    let collapsed = true, busy = false, current, renderKey = '';
    try { collapsed = localStorage.getItem('relayDesk.workbenchUsageCollapsed') !== 'false'; } catch {}
    const formatTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const dateText = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? formatTime.format(value) : '';
    container.className = 'account-usage';
    container.innerHTML = '<div class="account-usage-header"><button type="button" class="account-usage-toggle" aria-expanded="false"><img src="icons/chevron-down.svg" alt=""><span>Claude · 额度</span></button><button type="button" class="icon-button account-usage-refresh" title="刷新额度" aria-label="刷新 Claude 额度"><img src="icons/refresh.svg" alt=""></button></div><div class="account-usage-body" hidden><p class="account-usage-scope"></p><div class="account-usage-windows"></div><p class="account-usage-model-note"></p><p class="account-usage-updated"></p></div>';
    const toggle = container.querySelector('.account-usage-toggle');
    const button = container.querySelector('.account-usage-refresh');
    toggle.onclick = () => { collapsed = !collapsed; try { localStorage.setItem('relayDesk.workbenchUsageCollapsed', String(collapsed)); } catch {} render(current); };
    button.onclick = async () => {
      if (busy) return;
      busy = true; render(current);
      try { render(await refresh()); } catch (problem) { error(problem); }
      finally { busy = false; render(current); }
    };
    function render(snapshot) {
      current = snapshot;
      const entry = snapshot?.claudeUsage;
      container.hidden = !entry?.enabled;
      if (!entry?.enabled) return;
      container.classList.toggle('collapsed', collapsed);
      container.querySelector('.account-usage-body').hidden = collapsed;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      button.disabled = busy || Boolean(entry.loading);
      button.title = entry.online ? '刷新已有账号额度；CLI 查询最多每五分钟一次，不发送模型请求' : '连接 Relay VPS 并刷新额度';
      button.querySelector('img').classList.toggle('spinner', button.disabled);
      const key = JSON.stringify([entry, Math.floor(Date.now() / 30000)]);
      if (key === renderKey) return;
      renderKey = key;
      container.querySelector('.account-usage-scope').textContent = `${entry.accountName} · Claude 账号共享`;
      container.querySelector('.account-usage-scope').title = '此处仅显示 Relay VPS 上的 Claude 订阅账号，不代表本机角色或 API Key 的额度。';
      const list = container.querySelector('.account-usage-windows'); list.replaceChildren();
      for (const item of entry.windows || []) {
        if (!Number.isFinite(item.usedPercent)) continue;
        const used = Math.max(0, Math.min(100, item.usedPercent));
        const remaining = 100 - used;
        const expired = Number.isFinite(item.resetsAt) && item.resetsAt * 1000 <= Date.now();
        const row = document.createElement('div'); row.className = 'account-usage-window'; row.dataset.windowId = item.id;
        const heading = document.createElement('div'); heading.className = 'account-usage-heading';
        const label = document.createElement('span'); label.textContent = item.label;
        const value = document.createElement('strong'); value.textContent = expired ? '待更新' : `剩余 ${remaining.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
        value.title = `已用 ${used}%；剩余 = 100% − 已用。`;
        heading.append(label, value);
        const bar = document.createElement('progress'); bar.max = 100; bar.value = used;
        bar.title = '浅色表示已用，深色表示剩余。'; bar.setAttribute('aria-label', `${item.label} 已用 ${used}%，${value.textContent}`);
        const reset = document.createElement('small'); const resetAt = dateText(item.resetsAt * 1000);
        reset.textContent = expired ? '已到重置时间，等待更新' : resetAt ? `${resetAt} 重置` : '重置时间暂不可用';
        row.append(heading, bar, reset); list.append(row);
      }
      if (!list.childElementCount) {
        const empty = document.createElement('p'); empty.className = 'account-usage-empty';
        empty.textContent = entry.loading ? '正在读取账号额度…' : entry.online ? '账号尚未报告额度，请稍后刷新' : '点击刷新，连接后读取账号额度';
        list.append(empty);
      }
      const modelNote = container.querySelector('.account-usage-model-note');
      modelNote.textContent = entry.windows?.some(w => /fable/i.test(w.modelName || w.label)) ? 'Fable 周额度计入总周额度；并非额外增加。' : entry.source === 'claude-cli-control' ? '账号未返回模型专项额度，不按满额估算。' : '';
      const updated = dateText(entry.updatedAt);
      const prefix = entry.reason === 'server_busy' ? '服务器繁忙 · 上次数据' : entry.cached || !entry.online ? '缓存数据' : '已同步';
      container.querySelector('.account-usage-updated').textContent = `${prefix}${updated ? ' · ' + updated : ''} · 北京时间`;
    }
    return { render };
  }
  window.createQuotaPanel = createQuotaPanel;
})();
