const path = require('node:path');
const { Backend } = require('../backend.cjs');
const backend = new Backend(path.resolve(__dirname, '../..'));
backend.on('log', (text) => console.log(text));
(async () => {
  try {
    const status = await backend.connect();
    if (status.ssh !== 'ready' || status.tunnel !== 'ready' || status.mcp !== 'ready') throw new Error('Stack is not ready.');
    const info = await backend.exec('bash -n ~/windows-mcp/start-desktop-session.sh ~/windows-mcp/start-claude-container.sh ~/windows-mcp/start-codex-container.sh ~/windows-mcp/start-codex.sh && bash ~/windows-mcp/start-codex-container.sh --version && printf SERVER_SCRIPTS_OK');
    console.log(info);
    console.log('Authenticated SSH, MCP, forwarding, and server synchronization passed.');
  } finally { backend.stop(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
