const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsMcpFailed, emptyPrompt } = require('../mcp-recovery.js');

test('detects named connection failures without matching healthy servers or ordinary tool errors', () => {
  assert.equal(windowsMcpFailed('MCP server "windows-mcp" disconnected · open /mcp to reconnect'), true);
  assert.equal(windowsMcpFailed('\x1b[31mwindows-mcp - Snapshot (MCP)\x1b[0m\nError: Transport is closed'), true);
  assert.equal(windowsMcpFailed('Failed to connect to windows-mcp'), true);
  assert.equal(windowsMcpFailed('windows-mcp connected, 14 tools'), false);
  assert.equal(windowsMcpFailed('MCP server "other" disconnected. windows-mcp connected'), false);
  assert.equal(windowsMcpFailed('windows-mcp - Click (MCP)\nError: Element not found'), false);
});

test('does not treat typed text, menu options, or command lines as an empty input prompt', () => {
  assert.equal(emptyPrompt('❯ '), true);
  assert.equal(emptyPrompt('  › '), true);
  assert.equal(emptyPrompt('❯ draft message'), false);
  assert.equal(emptyPrompt('❯ /mcp'), false);
  assert.equal(emptyPrompt('❯ 1. Reconnect'), false);
  assert.equal(emptyPrompt('user@server:~$ '), false);
  assert.equal(emptyPrompt('Working…'), false);
});
