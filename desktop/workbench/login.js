const terminal = new Terminal({ fontSize: 15, fontFamily: 'Cascadia Mono, Consolas, monospace', cursorBlink: true, convertEol: true });
const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal')); fit.fit();
window.login.onData(value => terminal.write(value)); terminal.onData(value => window.login.input(value)); window.addEventListener('resize', () => fit.fit());
const remote = document.getElementById('remote-login');
const authorize = document.getElementById('login-authorize');
const code = document.getElementById('login-code');
window.login.onRemote(hasUrl => {
  remote.hidden = false;
  authorize.disabled = !hasUrl;
  fit.fit();
});
window.login.onAuthorizeReady(() => { authorize.disabled = false; });
window.login.onStatus(value => { document.getElementById('login-status').textContent = value; fit.fit(); });
authorize.onclick = () => window.login.authorize();
document.getElementById('login-code-form').onsubmit = event => {
  event.preventDefault();
  const value = code.value.trim();
  if (!value || /[\r\n]/.test(value)) return;
  window.login.input(value + '\r');
  code.value = '';
};
