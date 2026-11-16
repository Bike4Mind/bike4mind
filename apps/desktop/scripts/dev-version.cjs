const { execFileSync } = require('node:child_process');
const { latestStableVersion } = require('./package-local.cjs');

const REVISION = /^[a-f0-9]+$/;

// The identifier is always prefixed: a revision that happens to be all digits would otherwise be a
// numeric SemVer identifier, which may not have a leading zero.
function resolveDevVersion({ tags, revision, dirty, tagDate }) {
  if (typeof revision !== 'string' || !REVISION.test(revision)) {
    return { version: '0.0.0-dev.unknown', basis: 'source revision unavailable' };
  }
  const suffix = `g${revision}${dirty ? '.dirty' : ''}`;
  let latest;
  try {
    latest = latestStableVersion(typeof tags === 'string' ? tags : '');
  } catch {
    latest = undefined;
  }
  if (latest === undefined) {
    return {
      version: `0.0.0-dev.untagged.${suffix}`,
      basis: 'no local desktop release tags; run git fetch origin --tags',
    };
  }
  const dated = tagDate ? ` (${tagDate})` : '';
  return {
    version: `${latest}-dev.${suffix}`,
    basis: `newest local tag desktop-v${latest}${dated}; run git fetch origin --tags if that looks old`,
  };
}

/** Reads the dev version from the local checkout with no network. Never throws. */
function readDevVersion(cwd) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['--no-optional-locks', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };
  try {
    const revision = git('rev-parse', '--short=12', 'HEAD');
    if (!revision) return resolveDevVersion({ revision: undefined });
    const tags = git('tag', '--list', 'desktop-v*', '--merged', 'HEAD');
    if (tags === undefined) {
      return { version: '0.0.0-dev.unknown', basis: 'local desktop release tags unavailable' };
    }
    const status = git('status', '--porcelain', '--untracked-files=no');
    if (status === undefined) {
      return { version: '0.0.0-dev.unknown', basis: 'working-tree status unavailable' };
    }
    const dirty = status !== '';
    let latest;
    try {
      latest = latestStableVersion(tags);
    } catch {
      latest = undefined;
    }
    const tagDate = latest === undefined ? undefined : git('log', '-1', '--format=%cs', `desktop-v${latest}`, '--');
    return resolveDevVersion({ tags, revision, dirty, tagDate });
  } catch {
    return resolveDevVersion({ revision: undefined });
  }
}

module.exports = { resolveDevVersion, readDevVersion };
