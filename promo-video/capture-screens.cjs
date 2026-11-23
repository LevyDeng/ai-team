const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
app.setPath('userData', path.join(__dirname, '.tmp-capture-userdata'));

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(__dirname, 'screens');
fs.mkdirSync(outDir, { recursive: true });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(60);
  win.webContents.debugger.attach('1.3');

  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });

  await win.loadFile(path.join(repoRoot, 'desktop/workbench/index.html'));
  await wait(800);

  const js = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (err) { throw new Error('JS failed: ' + code + '\n' + err.message + '\nConsole: ' + errors.join('; ')); }
  };

  async function snap(fileName) {
    await wait(320);
    await js(`(() => {
      document.querySelectorAll('label[for="project-order"]').forEach(el => { if (el.textContent.includes('?')) el.textContent = '项目排序'; });
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const { data } = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(outDir, fileName), buf);
    console.log('Captured', fileName, buf.length, 'bytes');
  }

  await win.webContents.insertCSS('#toast { display: none !important; }');
  await js(`window.applyDeskTheme('light');`);
  await wait(250);

  // 1. Overview (Light) — Group chat
  await js(`(() => { chatId = 'chat-group'; showPage('projects'); activateChat(); const m = $('messages'); m.scrollTop = m.scrollHeight; })()`);
  await snap('01-overview-light.png');

  // 2a. Group chat with @ mention menu open
  await js(`(() => {
    const inp = $('input');
    inp.focus();
    inp.value = '@';
    inp.selectionStart = inp.selectionEnd = 1;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await snap('02a-group-mention-light.png');

  // 2b. Group chat with the input queue and interrupt controls visible.
  await js(`(() => {
    const inp = $('input');
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const m = $('messages');
    m.scrollTop = m.scrollHeight;
  })()`);
  await snap('02b-group-queue-light.png');

  // 2c. Chat settings dialog (showing moderator & history compression!)
  await js(`(() => {
    $('chat-settings').click();
    setTimeout(() => {
      const mod = document.querySelector('.moderator-settings');
      if (mod) mod.scrollIntoView({ block: 'center' });
    }, 60);
  })()`);
  await wait(200);
  await snap('02c-chat-settings-light.png');

  await js(`$('dialog').close();`);
  await wait(120);

  // 3a. Workflow chat view (with steps expanded)
  await js(`(() => {
    filter = 'workflow';
    chatId = 'chat-workflow';
    renderSidebar();
    activateChat();
    document.querySelectorAll('#workflow-status details').forEach((d, idx) => { if (idx === 0) d.open = true; });
  })()`);
  await snap('03a-workflow-light.png');

  // 3b. Role Priorities table view
  await js(`(() => {
    showPage('roles');
    $('role-priorities-open')?.click();
  })()`);
  await snap('03b-priority-light.png');

  // 4. Role editor with connection configuration expanded (showing local CLI + remote server option)
  await js(`(() => {
    showPage('roles');
    editRole(state.roles.find(r => r.id === 'role-be'));
    document.querySelectorAll('#role-form details').forEach(d => { d.open = true; });
  })()`);
  await snap('04-role-connect-light.png');

  // 5. Quota Center dialog (Light, with Claude, Codex, Antigravity, Cursor)
  await js(`(() => {
    filter = 'all';
    chatId = 'chat-group';
    showPage('projects');
    activateChat();
    openUsage();
  })()`);
  await snap('05-quota-light.png');

  await js(`$('dialog').close();`);
  await wait(120);

  // 6a. Built-in Project Tools (File preview open) - Light mode
  await js(`(async () => {
    await openTools('files');
    await loadFiles('read', ['src', 'payment', 'callback.ts']);
  })()`);
  await wait(250);
  await snap('06a-tools-light.png');

  // 6b. Built-in Project Tools - Dark mode (exact same layout for smooth theme wipe!)
  nativeTheme.themeSource = 'dark';
  await js(`window.applyDeskTheme('dark');`);
  await wait(300);
  await snap('06b-tools-dark.png');

  if (errors.length) console.warn('Renderer console errors:', errors);
  app.exit(0);
}).catch(err => {
  console.error(err);
  app.exit(1);
});
