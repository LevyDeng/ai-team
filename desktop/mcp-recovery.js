(() => {
  function windowsMcpFailed(output) {
    const text = String(output).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    return /MCP server ["']?windows-mcp["']?[^\r\n]{0,160}(?:disconnected|failed to connect|connection (?:closed|lost))/i.test(text)
      || /windows-mcp[\s\S]{0,220}?(?:transport (?:is )?(?:closed|error)|not connected|failed to connect|ECONNRESET|ECONNREFUSED)/i.test(text)
      || /(?:disconnected from|failed to connect(?: to)?)[ \t:'"]{0,12}(?:MCP server ["']?)?windows-mcp\b/i.test(text);
  }
  function emptyPrompt(line) { return /^[❯›>]\s*$/u.test(line.trimStart()); }
  const api = Object.freeze({ windowsMcpFailed, emptyPrompt });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.relayMcpRecovery = api;
})();
