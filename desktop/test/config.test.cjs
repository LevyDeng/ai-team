const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, shellQuote, hostMatches } = require('../config.cjs');

test('dotenv treats values as literal data and rejects duplicate keys', () => {
  const values = parseEnv('\uFEFF# Settings\r\nSSH_TARGET=user@example.test\r\nSSH_KEY_PATH="C:/Key folder/key"\r\nVALUE=$(touch /tmp/unwanted)\r\n');
  assert.equal(values.SSH_KEY_PATH, 'C:/Key folder/key');
  assert.equal(values.VALUE, '$(touch /tmp/unwanted)');
  assert.throws(() => parseEnv('KEY=one\nKEY=two'), /Duplicate/);
  assert.throws(() => parseEnv('not a setting'), /Invalid/);
});
test('remote project paths are quoted without executing shell syntax', () => {
  assert.equal(shellQuote('/home/user/my project'), "'/home/user/my project'");
  assert.equal(shellQuote("/home/user/a'; touch /tmp/unwanted; '"), "'/home/user/a'\"'\"'; touch /tmp/unwanted; '\"'\"''");
  assert.throws(() => shellQuote('bad\0path'), /Invalid/);
});
test('SSH host verification only accepts an exact trusted host key', () => {
  const trusted = [Buffer.from('trusted-server-key')];
  assert.equal(hostMatches(Buffer.from('trusted-server-key'), trusted), true);
  assert.equal(hostMatches(Buffer.from('untrusted-key'), trusted), false);
  assert.equal(hostMatches(Buffer.from('trusted-server-kez'), trusted), false);
});
