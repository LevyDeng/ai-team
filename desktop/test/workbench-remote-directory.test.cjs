const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Locations } = require('../workbench/locations.cjs');

function fixture() {
  const calls = [];
  const uploads = [];
  const client = {
    sftp(callback) {
      callback(null, {
        fastPut(source, target, options, done) {
          uploads.push(path.basename(source));
          done();
        },
        end() {},
      });
    },
  };
  const locations = new Locations({ directory: __dirname, get: () => ({ name: 'Test VPS' }) });
  locations.connect = async () => client;
  locations.exec = async (id, command) => {
    calls.push([id, command]);
    return command === 'printf %s "$HOME"' ? '/home/test' : '';
  };
  return { locations, calls, uploads };
}

test('The SSH runner prepares configured project directories before uploading its scripts', async () => {
  const { locations, calls, uploads } = fixture();
  await locations.runner('vps', "~/projects/team's project");
  const quoted = "'/home/test/projects/team'\"'\"'s project'";
  assert.deepEqual(calls[1], ['vps', `umask 077; mkdir -p -- ${quoted} && test -x ${quoted}`]);
  assert.deepEqual(uploads, ['native-history.py', 'run-agent.py']);

  const target = await locations.ensureProjectDirectory('vps', '/srv/project', '/home/test');
  assert.equal(target, '/srv/project');
});

test('Directory setup errors identify the VPS and project path before starting the runner', async () => {
  const { locations, uploads } = fixture();
  const failure = new Error('Permission denied');
  locations.exec = async (id, command) => {
    if (command === 'printf %s "$HOME"') return '/home/test';
    throw failure;
  };
  await assert.rejects(locations.runner('vps', '~/project'), error => {
    assert.match(error.message, /Test VPS.*~\/project/);
    return error.cause === failure;
  });
  assert.deepEqual(uploads, []);
});
