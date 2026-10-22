const { execFileSync, spawnSync } = require('node:child_process');

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function resolveVersion(override, tags, revision) {
  if (override !== undefined) {
    if (!versionPattern.test(override) || override.split('-').slice(1).join('-').split('.').some(part => /^0\d+$/.test(part))) {
      throw new Error('DESKTOP_VERSION must be a valid SemVer without build metadata');
    }
    return override;
  }
  const versions = tags.split(/\s+/).filter(tag => tag.startsWith('desktop-v'))
    .filter(tag => tag !== 'desktop-v1.0.0')
    .map(tag => tag.slice(9)).filter(version => stable.test(version));
  if (versions.some(version => !version.startsWith('0.'))) {
    throw new Error('Major desktop releases require an explicit beta policy change');
  }
  versions.sort((a, b) => {
    const left = a.split('.').map(BigInt);
    const right = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
    }
    return 0;
  });
  if (!versions.length) throw new Error('No desktop tags. Run git fetch origin --tags or set DESKTOP_VERSION explicitly.');
  if (!/^[a-f0-9]+$/.test(revision)) throw new Error('Invalid git revision');
  return `${versions[0]}-local.${revision}`;
}

function builderArgs(args, version, platform, identity) {
  if (args.some(arg => /publish|extraMetadata\.version|mac\.identity|forceCodeSigning/.test(arg))) {
    throw new Error('Use DESKTOP_VERSION and DESKTOP_MAC_IDENTITY for local overrides; publication is disabled.');
  }
  const mac = args.includes('--mac') || (!args.includes('--linux') && !args.includes('--win') && platform === 'darwin');
  return [...args, '--publish', 'never', `-c.extraMetadata.version=${version}`,
    ...(mac ? [`-c.mac.identity=${identity || '-'}`] : [])];
}

if (require.main === module) {
  try {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const version = resolveVersion(process.env.DESKTOP_VERSION,
      git('tag', '--list', 'desktop-v*', '--merged', 'HEAD'), git('rev-parse', '--short=12', 'HEAD'));
    const args = builderArgs(process.argv.slice(2), version, process.platform, process.env.DESKTOP_MAC_IDENTITY);
    console.log(`Local desktop package: ${version} (publication disabled)`);
    const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'electron-builder', ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveVersion, builderArgs };
