const stableVersion = /^(0|[1-9]\d{0,11})\.(0|[1-9]\d{0,11})\.(0|[1-9]\d{0,11})$/;
const packageVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const versionFromOutput = output => output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0] || '';

function hasUpdate(installed, latest) {
  if (typeof installed !== 'string' || typeof latest !== 'string') return false;
  const target = stableVersion.exec(latest);
  const current = packageVersion.test(installed) && stableVersion.exec(installed.split('-')[0]);
  if (!current || !target) return false;
  for (let i = 1; i <= 3; i++) {
    if (target[i] !== current[i]) return Number(target[i]) > Number(current[i]);
  }
  return installed.includes('-');
}

async function npmLatest(name, request = fetch) {
  const response = await request('https://registry.npmjs.org/' + encodeURIComponent(name) + '/latest', {
    signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Could not read the official npm registry.');
  const pkg = await response.json();
  if (pkg?.name !== name || typeof pkg.version !== 'string' || !packageVersion.test(pkg.version)) {
    throw new Error('Unexpected official package metadata.');
  }
  return pkg.version;
}

module.exports = { hasUpdate, npmLatest, packageVersion, stableVersion, versionFromOutput };
