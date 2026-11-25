const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { AppReleaseUpdate, portableBoot } = require('../workbench/app-release-update.cjs');

const apiUrl = 'https://api.github.com/repos/LevyDeng/ai-team/releases/latest';
const downloads = 'https://github.com/LevyDeng/ai-team/releases/download/';

function asset(tag, version, options = {}) {
  const name = `ai-team-${version}-win-x64.zip`;
  return { name, state: 'uploaded', browser_download_url: downloads + tag + '/' + name, ...options };
}

function release(tag, assets) {
  return { tag_name: tag, draft: false, prerelease: false, assets };
}

test('app update compares the published executable package version independently of the release tag', async () => {
  const update = new AppReleaseUpdate({
    version: '0.1.0',
    request: async (url, options) => {
      assert.equal(url, apiUrl);
      assert.equal(options.redirect, 'error');
      return Response.json(release('1.0.0', [asset('1.0.0', '0.1.0')]));
    },
    open: () => assert.fail('The current package must not be opened.'),
  });
  assert.deepEqual(await update.check(), { status: 'current', version: '0.1.0' });
  await assert.rejects(update.download());
});

test('app update opens only the approved official Windows x64 asset after an explicit download', async () => {
  const opened = [];
  const valid = asset('v0.2.0', '0.2.0');
  let requests = 0;
  const update = new AppReleaseUpdate({
    version: '0.1.0',
    request: async () => {
      requests++;
      return Response.json(release('v0.2.0', [
        asset('v0.2.0', '0.3.0', { browser_download_url: 'https://example.com/other.zip' }),
        asset('v0.2.0', '0.4.0', { state: 'new' }),
        valid,
      ]));
    },
    open: async url => opened.push(url),
  });
  await assert.rejects(update.download());
  const expected = { status: 'available', version: '0.2.0', direct: false };
  assert.deepEqual(await Promise.all([update.check(), update.check()]), [expected, expected]);
  assert.equal(requests, 1);
  assert.deepEqual(opened, []);
  await update.download();
  assert.deepEqual(opened, [valid.browser_download_url]);
});

test('app update distinguishes no release, no package and a failed check', async () => {
  let response;
  const update = new AppReleaseUpdate({ version: '0.1.0', request: async () => response });
  response = new Response(null, { status: 404 });
  assert.deepEqual(await update.check(), { status: 'no-release' });
  response = Response.json(release('v0.2.0', []));
  assert.deepEqual(await update.check(), { status: 'no-package' });
  response = Response.json(release('v0.2.0', [asset('v0.2.0', '0.2.0')]));
  assert.equal((await update.check()).status, 'available');
  response = new Response(null, { status: 403 });
  await assert.rejects(update.check());
  await assert.rejects(update.download());
});

test('one-click updating requires a supported package and GitHub verification metadata', async () => {
  const unverified = asset('v0.2.0', '0.2.0', { size: 42 });
  let next = unverified;
  const update = new AppReleaseUpdate({
    version: '0.1.1', directory: 'portable-folder',
    request: async () => Response.json(release('v0.2.0', [next])),
  });
  assert.equal((await update.check()).direct, false);
  await assert.rejects(update.prepare());
  next = { ...unverified, digest: 'sha256:' + '0'.repeat(64), size: 1024 ** 3 + 1 };
  assert.equal((await update.check()).direct, false);
  next = { ...next, size: 42 };
  assert.equal((await update.check()).direct, true);
});

test('updater streams verified bytes from the GitHub asset CDN and rejects tampered assets', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-team-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('valid zip fixture bytes');
  const digest = createHash('sha256').update(body).digest('hex');
  const url = asset('v0.2.0', '0.2.0').browser_download_url;
  let destination = 'https://release-assets.githubusercontent.com/example';
  const update = new AppReleaseUpdate({ request: async (input, options) => {
    assert.equal(options.redirect, 'manual');
    return input === url ? new Response(null, { status: 302, headers: { Location: destination } }) : new Response(body);
  } });
  const target = { url, digest, size: body.length };
  const file = path.join(directory, 'valid.zip');
  await update.fetchPackage(target, file);
  assert.deepEqual(await fs.readFile(file), body);
  await assert.rejects(update.fetchPackage({ ...target, digest: '0'.repeat(64) }, path.join(directory, 'invalid.zip')), /verification/);
  await assert.rejects(update.fetchPackage({ ...target, size: body.length - 1 }, path.join(directory, 'too-big.zip')), /size/);
  destination = 'https://example.com/asset.zip';
  await assert.rejects(update.fetchPackage(target, path.join(directory, 'untrusted.zip')), /redirect/);
});

test('pending update claims only its own restarted app and records acceptance durably', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-team-update-boot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = 'a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1';
  const base = path.join(directory, '.ai-team-update');
  await fs.mkdir(base);
  await fs.writeFile(path.join(base, 'active.json'), JSON.stringify({ id }));
  assert.ok(portableBoot(directory, []).recovery);
  const boot = portableBoot(directory, ['--portable-update=' + id]);
  assert.equal(boot.accepted(), false);
  await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ status: 'installed', id: 'other' }));
  assert.equal(boot.accepted(), false);
  await fs.writeFile(path.join(base, 'result.json'), JSON.stringify({ status: 'installed', id }));
  assert.equal(boot.accepted(), true);
});
