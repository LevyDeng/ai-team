(() => {
  const phases = { queued: '等待开始', downloading: '正在下载并安装新版…', verifying: '正在验证版本和接口…', checking_usage: '正在验证额度读取兼容性…', switching: '正在切换镜像…', complete: '已完成', failed: '操作失败' };
  const reasons = { updated: '更新成功，后续新任务将使用新版。已有会话仍使用原版本。', prepared: '新版已下载并通过验证，点击一键更新即可应用。', rolled_back: '已回退，后续新任务将使用上一版。', up_to_date: '当前版本已是最新，无需更新。', insufficient_memory: '可用内存不足 1 GiB，请等服务器任务减少后重试。', insufficient_disk: 'Docker 所在磁盘可用空间不足 2 GiB。', image_changed: '镜像在更新期间发生变化，已保留当前版本，请重新检查。', installer_failed: '安装失败，当前镜像保留。', version_verification_failed: '新版版本验证失败，当前镜像保留。', protocol_verification_failed: '新版接口验证失败，当前镜像保留。', previous_missing: '尚无可回退的上一版镜像。', worker_interrupted: '更新进程已中断，点击检查更新核对状态。', connection_lost: '连接中断；服务器会继续更新，恢复连接后点击检查更新。', release_query_failed: '暂时无法取得官方版本信息，请稍后重试。', update_failed: '更新失败，当前镜像保留；可查看服务器更新日志。', operation_failed: '操作未完成，请检查服务器连接和 Docker 状态。' };
  window.createClaudeUpdateView = (container, { request, error }) => {
    let state = {}, pending = false;
    container.className = 'setting-card';
    container.innerHTML = '<h3>服务器 Claude Code</h3><p>更新服务器 Claude Code，已有任务继续使用原版本。</p><div class="claude-version-summary"><span>当前版本 <strong class="claude-installed">待检查</strong></span><span>最新正式版 <strong class="claude-latest">待检查</strong></span></div><div class="claude-update-actions"><button type="button" data-claude-action="check">检查更新</button><button type="button" data-claude-action="update" class="primary">一键更新</button><button type="button" data-claude-action="rollback">回退上一版</button></div><p class="claude-update-state" role="status"></p><p class="hint">更新后保留上一版，可回退。</p>';
    function render(next) {
      state = next || {};
      container.querySelector('.claude-installed').textContent = state.installed || '待检查';
      container.querySelector('.claude-latest').textContent = state.latest || '待检查';
      const busy = pending || state.busy || (state.state === 'running' && state.reason !== 'connection_lost');
      for (const button of container.querySelectorAll('[data-claude-action]')) {
        const action = button.dataset.claudeAction;
        button.disabled = !state.enabled || busy || (action !== 'check' && state.state === 'running') || (action === 'update' && state.latest && !state.available && !state.preparedVersion) || (action === 'rollback' && !state.canRollback);
      }
      const message = state.reason === 'connection_lost' ? reasons.connection_lost : state.state === 'running' ? phases[state.phase] || '正在更新…' : reasons[state.reason] || (state.available ? '有新版本可用。' : state.latest ? '当前没有可用更新。' : '点击检查更新读取服务器版本。');
      container.querySelector('.claude-update-state').textContent = !state.enabled ? '尚未配置托管服务器。' : pending ? '正在连接服务器…' : message;
    }
    for (const button of container.querySelectorAll('[data-claude-action]')) button.onclick = async () => {
      pending = true; render(state);
      try { render(await request(button.dataset.claudeAction)); }
      catch (problem) { error(problem); }
      finally { pending = false; render(state); }
    };
    return { render };
  };
})();
