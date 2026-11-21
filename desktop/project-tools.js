(() => {
  const $ = (id) => document.getElementById(id);
  const locationKey = ({ kind, path }) => `${kind}:${path}`;
  const locationName = (kind) => kind === 'local' ? 'Windows' : '服务器';
  function locationsFor(project) {
    if (project?.locations?.length) return project.locations;
    if (!project) return [];
    const locations = [{ kind: 'remote', path: project.path }];
    if (project.localPath) locations.unshift({ kind: 'local', path: project.localPath });
    return locations;
  }

  function create({ editDirectories, report }) {
    const api = window.relay;
    const panel = $('project-tools');
    const host = $('project-terminal-host');
    const select = $('project-tools-location');
    const terminals = new Map();
    const projectState = new Map();
    let project = null, current = null, online = false, opening = false;
    let activeView = null;
    let visible = false;
    let fileExpanded = false;
    try { visible = localStorage.getItem('relayDesk.projectTools') === 'true'; } catch {}

    const perform = (fn) => async (...args) => { try { await fn(...args); } catch (error) { report(error); } };
    const locations = () => locationsFor(project);
    const selection = () => locations().find((entry) => locationKey(entry) === current?.[current.tab]) || locations()[0];
    function note(text) {
      const node = document.createElement('div');
      node.className = 'project-tool-note'; node.textContent = text;
      return node;
    }
    function setVisible(value) {
      visible = value;
      if (!value) fileExpanded = false;
      try { localStorage.setItem('relayDesk.projectTools', String(value)); } catch {}
      render();
      maybeLoadFiles();
    }
    function setProject(value) {
      if (project?.id !== value?.id) fileExpanded = false;
      const signature = JSON.stringify(locationsFor(value));
      const changed = project?.id !== value?.id || JSON.stringify(locationsFor(project)) !== signature;
      project = value;
      if (project && !projectState.has(project.id)) projectState.set(project.id, { tab: 'files', parts: [], file: null, fileResult: null, fileRequest: 0 });
      current = project && projectState.get(project.id);
      if (!changed) return;
      if (current && current.signature !== signature) {
        current.signature = signature;
        current.files = current.terminal = locationKey(locations()[0]);
        current.parts = []; current.file = null; current.fileResult = null; current.fileRequest++;
      }
      render(); maybeLoadFiles();
    }
    function setStatus(status) {
      const ready = status.ssh === 'ready' && status.tunnel === 'ready';
      if (ready === online) return;
      online = ready;
      for (const state of projectState.values()) if (state.files?.startsWith('remote:')) { state.fileResult = null; state.fileRequest++; }
      render(); maybeLoadFiles();
    }

    function render() {
      panel.hidden = !visible || !project;
      updateFileExpansion();
      $('project-tools-toggle').disabled = !project;
      $('project-tools-toggle').setAttribute('aria-expanded', String(!panel.hidden));
      if (panel.hidden) return;
      $('project-tools-title').textContent = project.name;
      const files = current.tab === 'files';
      $('project-file-pane').hidden = !files;
      $('project-terminal-pane').hidden = files;
      $('project-tools-files').setAttribute('aria-pressed', String(files));
      $('project-tools-terminal').setAttribute('aria-pressed', String(!files));
      select.replaceChildren(...locations().map((entry) => new Option(`${locationName(entry.kind)} · ${entry.path}`, locationKey(entry))));
      const directory = selection();
      select.value = locationKey(directory);
      select.title = directory.path;
      if (files) renderFiles();
      else renderTerminals();
    }

    function updateFileExpansion() {
      const expanded = fileExpanded && !panel.hidden && current?.tab === 'files';
      panel.parentElement.classList.toggle('file-preview-expanded', expanded);
      const button = $('project-file-expand');
      button.textContent = expanded ? '收起' : '展开';
      button.title = expanded ? '收起文件预览，返回侧栏' : '展开文件预览，占满中间工作区';
      button.setAttribute('aria-pressed', String(expanded));
    }

    function renderFiles() {
      const entry = selection();
      const result = current.fileResult;
      const content = $('project-file-content');
      const filename = result?.path || [entry.path, ...current.parts, ...(current.file ? [current.file] : [])].join(entry.kind === 'local' ? '\\' : '/');
      $('project-file-path').textContent = filename;
      $('project-file-path').title = filename;
      $('project-file-up').disabled = !current.parts.length && !current.file;
      $('project-file-open').hidden = entry.kind !== 'local';
      $('project-file-open').disabled = !result?.path;
      $('project-file-copy').disabled = !result?.path;
      if (entry.kind === 'remote' && !online) { content.replaceChildren(note('连接服务器后可浏览该目录。')); return; }
      if (!result || result.loading) { content.replaceChildren(note('正在读取…')); return; }
      if (result.error) { content.replaceChildren(note(result.error)); return; }
      if (current.file) {
        if (result.binary) { content.replaceChildren(note('此文件为二进制格式。')); return; }
        const preview = document.createElement('pre');
        preview.textContent = result.text || '（空文件）';
        content.replaceChildren(preview);
        if (result.truncated) content.append(note('仅预览文件开头的 96 KiB。'));
      } else {
        const fragment = document.createDocumentFragment();
        const entries = [...result.entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const item of entries) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'quiet';
          button.textContent = item.directory ? `▸ ${item.name}` : `· ${item.name}`; button.title = item.name;
          button.onclick = () => {
            if (item.directory) current.parts.push(item.name);
            else current.file = item.name;
            loadFiles();
          };
          fragment.append(button);
        }
        if (!entries.length) fragment.append(note('目录为空。'));
        if (result.truncated) fragment.append(note('仅显示前 600 项。'));
        content.replaceChildren(fragment);
      }
      content.scrollTop = 0;
    }
    async function loadFiles() {
      if (panel.hidden || current?.tab !== 'files') return;
      const state = current, entry = selection(), projectId = project.id;
      if (entry.kind === 'remote' && !online) return;
      const request = ++state.fileRequest;
      const parts = state.file ? [...state.parts, state.file] : [...state.parts];
      state.fileResult = { loading: true }; renderFiles();
      let result;
      try { result = await api.projectFiles(projectId, entry, parts, state.file ? 'preview' : 'list'); }
      catch (error) { result = { error: error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '') }; }
      if (state.fileRequest !== request) return;
      state.fileResult = result;
      if (current === state && !panel.hidden && state.tab === 'files') renderFiles();
    }
    function maybeLoadFiles() { if (current?.tab === 'files' && !current.fileResult) loadFiles(); }

    function updateClipboardButtons() {
      $('project-terminal-copy').disabled = !activeView?.terminal.hasSelection();
      $('project-terminal-paste').disabled = terminals.get(activeView?.id)?.info.state !== 'ready';
    }
    function pasteText(view, text) {
      if (!view || activeView !== view || panel.hidden || current?.tab !== 'terminal' || terminals.get(view.id)?.info.state !== 'ready' || !text) return;
      // Leave room for the bracketed paste markers in the terminal input limit.
      if (text.length > 99988) throw new Error('剪贴板文字过长，请分段粘贴。');
      view.terminal.paste(text);
      view.terminal.focus();
    }
    const copyTerminal = perform(async (view) => {
      const text = view?.terminal.getSelection();
      if (text) await api.copyText(text);
    });
    const pasteTerminal = perform(async (view) => {
      if (terminals.get(view?.id)?.info.state === 'ready') pasteText(view, await api.readClipboardText());
    });

    function createTerminalView(entry) {
      const element = document.createElement('div'); element.className = 'project-shell-view'; host.append(element);
      const terminal = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 4000,
        theme: { background: '#13171c', foreground: '#dfe6eb', cursor: '#95d5bf' } });
      const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(element);
      window.relayTerminalUI.installLinks(terminal,{openPath:value=>api.openProjectPath(entry.info.projectId||project.id,value),openLink:value=>api.openLink(value),error:report});
      const view = { element, terminal, fit, id: entry.info.id };
      entry.view = view;
      if (entry.output) { terminal.write(entry.output); entry.output = ''; }
      terminal.onData((data) => { if (entry.info.state === 'ready') api.inputProjectTerminal(entry.info.id, data).catch(report); });
      terminal.onSelectionChange(() => { if (activeView === view) updateClipboardButtons(); });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
        const key = event.key.toLowerCase();
        if (key === 'v' || (key === 'c' && (terminal.hasSelection() || event.shiftKey))) {
          event.preventDefault();
          event.stopPropagation();
          if (key === 'v') pasteTerminal(view);
          else copyTerminal(view);
          return false;
        }
        return true;
      });
      element.addEventListener('paste', (event) => {
        if (!event.clipboardData) return;
        event.preventDefault();
        event.stopPropagation();
        try { pasteText(view, event.clipboardData.getData('text/plain')); } catch (error) { report(error); }
      }, true);
      return view;
    }
    const terminalEmpty = note('点击“新建终端”，在所选目录启动终端。');
    host.append(terminalEmpty);
    function fitTerminal() {
      const view = activeView;
      if (panel.hidden || current?.tab !== 'terminal' || !view || !host.clientWidth || !host.clientHeight) return;
      view.fit.fit();
      if (document.hasFocus()) api.resizeProjectTerminal(view.id, view.terminal.cols, view.terminal.rows).catch(() => {});
    }
    function renderTerminals() {
      const directory = selection();
      $('project-terminal-new').disabled = opening || (directory.kind === 'remote' && !online);
      const entries = [...terminals.values()].filter((entry) => entry.info.projectId === project.id);
      if (!entries.some((entry) => entry.info.id === current.terminalId)) current.terminalId = entries.at(-1)?.info.id;
      const active = terminals.get(current.terminalId);
      const tabs = $('project-terminal-tabs'); tabs.replaceChildren();
      for (const { info } of entries) {
        const tab = document.createElement('div'); tab.className = 'project-terminal-tab';
        tab.classList.toggle('active', info.id === current.terminalId);
        const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'quiet';
        pick.textContent = `${locationName(info.kind)} ${info.number}${info.state === 'ended' ? ' · 已结束' : ''}`; pick.title = info.cwd;
        pick.onclick = () => { current.terminalId = info.id; renderTerminals(); activeView?.terminal.focus(); };
        const close = document.createElement('button'); close.type = 'button'; close.className = 'quiet'; close.textContent = '×'; close.setAttribute('aria-label', `关闭终端 ${info.number}`);
        close.onclick = perform(() => api.closeProjectTerminal(info.id));
        tab.append(pick, close); tabs.append(tab);
      }
      activeView = active ? active.view || createTerminalView(active) : null;
      updateClipboardButtons();
      for (const entry of terminals.values()) if (entry.view) entry.view.element.hidden = entry.view !== activeView;
      terminalEmpty.hidden = Boolean(active);
      terminalEmpty.textContent = directory.kind === 'remote' && !online ? '连接服务器后可新建 SSH 终端。' : '点击“新建终端”，在所选目录启动终端。';
      $('project-terminal-path').textContent = active?.info.cwd || directory.path;
      $('project-terminal-path').title = $('project-terminal-path').textContent;
      requestAnimationFrame(fitTerminal);
    }
    function receive(event) {
      if (event.type === 'state') {
        const entry = terminals.get(event.info.id);
        if (entry) entry.info = event.info;
        else terminals.set(event.info.id, { info: event.info, output: event.info.output || '', sequence: event.info.sequence || 0 });
      } else {
        const entry = terminals.get(event.id);
        if (!entry) return;
        if (event.type === 'data') {
          if (event.sequence <= entry.sequence) return;
          entry.sequence = event.sequence;
          if (entry.view) entry.view.terminal.write(event.data);
          else entry.output = (entry.output + event.data).slice(-160000);
          return;
        }
        entry.view?.terminal.dispose(); entry.view?.element.remove(); terminals.delete(event.id);
      }
      if (!panel.hidden && current?.tab === 'terminal') renderTerminals();
    }
    let queued = [];
    api.on('project-terminal', (event) => { if (queued) queued.push(event); else receive(event); });
    api.projectTerminals().then((list) => { for (const info of list) receive({ type: 'state', info }); }).catch(report).finally(() => {
      const events = queued; queued = null;
      for (const event of events) receive(event);
    });

    $('project-tools-toggle').onclick = () => setVisible(!visible);
    $('project-tools-close').onclick = () => { setVisible(false); $('project-tools-toggle').focus(); };
    $('project-tools-settings').onclick = () => editDirectories(project.id);
    $('project-tools-files').onclick = () => { current.tab = 'files'; render(); maybeLoadFiles(); };
    $('project-tools-terminal').onclick = () => { current.tab = 'terminal'; render(); };
    select.onchange = () => {
      current[current.tab] = select.value;
      if (current.tab === 'files') { current.parts = []; current.file = null; current.fileResult = null; current.fileRequest++; render(); maybeLoadFiles(); }
      else renderTerminals();
    };
    $('project-file-up').onclick = () => { if (current.file) current.file = null; else current.parts.pop(); loadFiles(); };
    $('project-file-refresh').onclick = () => loadFiles();
    $('project-file-expand').onclick = () => { fileExpanded = !fileExpanded; updateFileExpansion(); };
    $('project-file-copy').onclick = perform(() => api.copyText(current.fileResult.path));
    $('project-file-open').onclick = perform(() => api.projectFiles(project.id, selection(), current.file ? [...current.parts, current.file] : current.parts, 'open'));
    $('project-terminal-copy').onclick = () => copyTerminal(activeView);
    $('project-terminal-paste').onclick = () => pasteTerminal(activeView);
    $('project-terminal-new').onclick = perform(async () => {
      const state = current;
      opening = true; renderTerminals();
      try { state.terminalId = await api.openProjectTerminal(project.id, selection()); }
      finally { opening = false; render(); }
      if (current === state && !panel.hidden && current.tab === 'terminal') activeView?.terminal.focus();
    });
    new ResizeObserver(fitTerminal).observe(host);
    window.addEventListener('focus', fitTerminal);
    return { setProject, setStatus };
  }
  window.relayProjectTools = Object.freeze({ create, locationsFor });
})();
