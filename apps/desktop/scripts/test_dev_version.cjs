const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { resolveDevVersion, readDevVersion } = require('./dev-version.cjs');

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

test('tagged checkout: newest tag, revision and a dirty marker', () => {
  const tags = 'desktop-v0.9.0\ndesktop-v0.10.0\ndesktop-v1.0.0\nv2026.10.15.4';
  const clean = resolveDevVersion({ tags, revision: 'abc123def456', dirty: false, tagDate: '2026-11-13' });
  assert.equal(clean.version, '0.10.0-dev.gabc123def456');
  assert.equal(
    clean.basis,
    'newest local tag desktop-v0.10.0 (2026-11-13); run git fetch origin --tags if that looks old'
  );
  const dirty = resolveDevVersion({ tags, revision: 'abc123def456', dirty: true, tagDate: '2026-11-13' });
  assert.equal(dirty.version, '0.10.0-dev.gabc123def456.dirty');
});

test('the basis never calls a local tag the latest release', () => {
  const { basis } = resolveDevVersion({ tags: 'desktop-v0.5.0', revision: 'abc', dirty: false, tagDate: '2026-01-02' });
  assert.match(basis, /newest local tag/);
  assert.doesNotMatch(basis, /latest release/);
});

test('no usable tags falls back to untagged', () => {
  const expected = {
    version: '0.0.0-dev.untagged.gabc',
    basis: 'no local desktop release tags; run git fetch origin --tags',
  };
  assert.deepEqual(resolveDevVersion({ tags: '', revision: 'abc', dirty: false }), expected);
  assert.deepEqual(resolveDevVersion({ tags: 'desktop-v1.0.0 v3.0.0', revision: 'abc', dirty: false }), expected);
  assert.deepEqual(resolveDevVersion({ tags: 'desktop-v2.0.0', revision: 'abc', dirty: false }), expected);
  assert.equal(resolveDevVersion({ tags: '', revision: 'abc', dirty: true }).version, '0.0.0-dev.untagged.gabc.dirty');
});

test('no revision falls back to unknown', () => {
  for (const revision of [undefined, '', 'not-hex', 'ABC', 'abc;rm']) {
    assert.deepEqual(resolveDevVersion({ tags: 'desktop-v0.5.0', revision, dirty: true }), {
      version: '0.0.0-dev.unknown',
      basis: 'source revision unavailable',
    });
  }
});

test('every version is valid SemVer, including all-digit and leading-zero revisions', () => {
  for (const revision of ['abc123', '0123456789', '0000000', '1e5']) {
    for (const tags of ['desktop-v0.203.0', '']) {
      for (const dirty of [false, true]) {
        const { version } = resolveDevVersion({ tags, revision, dirty, tagDate: '2026-11-13' });
        assert.match(version, SEMVER, version);
      }
    }
  }
  assert.match(resolveDevVersion({ revision: undefined }).version, SEMVER);
});

test('readDevVersion never throws and reports unknown outside a checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-version-none-'));
  try {
    assert.equal(readDevVersion(directory).version, '0.0.0-dev.unknown');
    assert.equal(readDevVersion(join(directory, 'does-not-exist')).version, '0.0.0-dev.unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readDevVersion reads tags, revision and tracked changes from a local repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-version-repo-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'dev@example.invalid');
    git('config', 'user.name', 'Dev');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(directory, 'file.txt'), 'one\n');
    git('add', 'file.txt');
    git('commit', '--quiet', '-m', 'first');
    git('tag', 'desktop-v0.4.0');
    git('tag', 'desktop-v0.12.0');
    const revision = git('rev-parse', '--short=12', 'HEAD');

    const clean = readDevVersion(directory);
    assert.equal(clean.version, `0.12.0-dev.g${revision}`);
    assert.match(clean.basis, /^newest local tag desktop-v0\.12\.0 \(\d{4}-\d{2}-\d{2}\); run git fetch origin --tags/);

    writeFileSync(join(directory, 'untracked.txt'), 'x\n');
    assert.equal(readDevVersion(directory).version, `0.12.0-dev.g${revision}`);

    writeFileSync(join(directory, 'file.txt'), 'two\n');
    assert.equal(readDevVersion(directory).version, `0.12.0-dev.g${revision}.dirty`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
