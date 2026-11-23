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
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false,
    backgroundColor: '#191d23',
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

  let latestImage = null;
  let paintWaiters = [];
  win.webContents.on('paint', (_event, _dirty, image) => {
    latestImage = image;
    if (paintWaiters.length) {
      const list = paintWaiters;
      paintWaiters = [];
      for (const resolve of list) resolve(image);
    }
  });

  async function waitPaint(ms = 450) {
    win.webContents.invalidate();
    await Promise.race([
      new Promise(resolve => paintWaiters.push(resolve)),
      wait(ms),
    ]);
  }

  async function snap(fileName) {
    await wait(220);
    await waitPaint(400);
    await wait(80);
    await waitPaint(300);
    const img = latestImage || await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, fileName), img.toPNG());
    console.log('Captured', fileName, img.getSize());
  }

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

  await win.webContents.insertCSS('#toast { display: none !important; }');
  await js(`window.applyDeskTheme('dark');`);
  await wait(300);

  // 1. Overview (Dark) — Group chat
  await js(`(() => { chatId = 'chat-group'; showPage('projects'); activateChat(); const m = $('messages'); m.scrollTop = m.scrollHeight; })()`);
  await snap('01-overview-dark.png');

  // 2. Group chat with @ mention menu open
  await js(`(() => {
    const inp = $('input');
    inp.focus();
    inp.value = '@';
    inp.selectionStart = inp.selectionEnd = 1;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await snap('02-group-chat-mention.png');

  // Clear mention input
  await js(`(() => {
    const inp = $('input');
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // 3. Workflow chat view (with steps expanded)
  await js(`(() => {
    filter = 'workflow';
    chatId = 'chat-workflow';
    renderSidebar();
    activateChat();
    document.querySelectorAll('#workflow-status details').forEach((d, idx) => { if (idx === 0) d.open = true; });
  })()`);
  await snap('03-workflow-chat.png');

  // 4. Role Priorities table view
  await js(`(() => {
    showPage('roles');
    $('role-priorities-open')?.click();
  })()`);
  await snap('04-role-priority.png');

  // 5. Role editor with connection configuration expanded
  await js(`(() => {
    showPage('roles');
    editRole(state.roles.find(r => r.id === 'role-be'));
    document.querySelectorAll('#role-form details').forEach(d => { d.open = true; });
  })()`);
  await snap('05-role-connect.png');

  // 6. Quota Center dialog
  await js(`(() => {
    filter = 'all';
    chatId = 'chat-group';
    showPage('projects');
    activateChat();
    openUsage();
  })()`);
  await snap('06-quota-center.png');

  await js(`$('dialog').close();`);
  await wait(120);

  // 7. Built-in Project Tools (File preview open) - Dark mode
  await js(`(async () => {
    await openTools('files');
    await loadFiles('read', ['src', 'payment', 'callback.ts']);
  })()`);
  await snap('07-tools-dark.png');

  // 8. Built-in Project Tools - Light mode (exact same layout for smooth wipe!)
  nativeTheme.themeSource = 'light';
  await js(`window.applyDeskTheme('light');`);
  await wait(300);
  await snap('08-tools-light.png');

  if (errors.length) console.warn('Renderer console errors:', errors);
  app.exit(0);
}).catch(err => {
  console.error(err);
  app.exit(1);
});
