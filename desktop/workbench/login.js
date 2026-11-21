const terminal = new Terminal({ fontSize: 15, fontFamily: 'Cascadia Mono, Consolas, monospace', cursorBlink: true, convertEol: true });
const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal')); fit.fit();
window.login.onData(value => terminal.write(value)); terminal.onData(value => window.login.input(value)); window.addEventListener('resize', () => fit.fit());
