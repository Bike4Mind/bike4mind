import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// electron-updater's own manifest parser and URL resolver, so the rewrite is checked against what
// an installed app will actually do with it rather than against a second YAML reading.
import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider';
import {
  compareVersions,
  isAheadOfLive,
  latestDmgName,
  main,
  MAINTENANCE_NOTE,
  releaseNotesFor,
  rewriteManifest,
} from './release.mjs';

const BUILT_MANIFEST = `version: 1.4.0
files:
  - url: Bike4Mind-1.4.0-arm64-mac.zip
    sha512: aaa==
    size: 101
  - url: Bike4Mind-1.4.0-mac.zip
    sha512: bbb==
    size: 102
  - url: Bike4Mind-1.4.0-arm64.dmg
    sha512: ccc==
    size: 103
path: Bike4Mind-1.4.0-arm64-mac.zip
sha512: aaa==
releaseDate: '2026-10-15T00:00:00.000Z'
`;

const CHANGELOG = `# @bike4mind/desktop

## 1.4.0

### Minor Changes

- [#4701](https://github.com/o/r/pull/4701) [\`abc1234\`](https://github.com/o/r/commit/abc1234) Thanks [@someone](https://github.com/someone)! - add a restart banner for downloaded updates

- [#4702](https://github.com/o/r/pull/4702) [\`def5678\`](https://github.com/o/r/commit/def5678) Thanks [@someone](https://github.com/someone)! - show release notes
  in the update banner

### Patch Changes

- Updated dependencies [[\`abc1234\`](https://github.com/o/r/commit/abc1234)]:
  - @bike4mind/common@15.0.0
  - @bike4mind/mcp@3.0.0
- 0123456789abcdef: fix the sidebar scroll

## 1.3.1

### Patch Changes

- Updated dependencies:
  - @bike4mind/common@14.2.0

## 1.3.0

### Minor Changes

- Older entry.
`;

describe('compareVersions', () => {
  it('orders by major, minor and patch numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('puts a prerelease below its release, and orders prereleases by identifier', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('ignores build metadata and refuses anything that is not semver', () => {
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/not a semver/);
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow(/not a semver/);
  });
});

describe('releaseNotesFor', () => {
  it('keeps only the entry text, in order, across the change kinds', () => {
    expect(releaseNotesFor(CHANGELOG, '1.4.0')).toBe(
      [
        '- add a restart banner for downloaded updates',
        '- show release notes in the update banner',
        '- fix the sidebar scroll',
      ].join('\n')
    );
  });

  it('turns a dependency-only release into a line rather than an empty banner', () => {
    expect(releaseNotesFor(CHANGELOG, '1.3.1')).toBe(MAINTENANCE_NOTE);
  });

  it('reads the last section to the end of the file', () => {
    expect(releaseNotesFor(CHANGELOG, '1.3.0')).toBe('- Older entry.');
  });

  it('is null for a version the changelog does not have, and never matches a prefix', () => {
    expect(releaseNotesFor(CHANGELOG, '1.5.0')).toBeNull();
    expect(releaseNotesFor(CHANGELOG, '1.4')).toBeNull();
  });
});

describe('rewriteManifest', () => {
  it('points every file at the version prefix and reports what it references', () => {
    const { text, files } = rewriteManifest(BUILT_MANIFEST, { version: '1.4.0', prefix: 'releases/v1.4.0' });

    expect(files).toEqual(['Bike4Mind-1.4.0-arm64-mac.zip', 'Bike4Mind-1.4.0-mac.zip', 'Bike4Mind-1.4.0-arm64.dmg']);
    expect(text).toContain('  - url: releases/v1.4.0/Bike4Mind-1.4.0-arm64-mac.zip\n');
    expect(text).toContain('path: releases/v1.4.0/Bike4Mind-1.4.0-arm64-mac.zip\n');
    expect(text).toContain("releaseDate: '2026-10-15T00:00:00.000Z'\n");
    expect(text).not.toContain('releaseNotes');
  });

  it('produces a manifest electron-updater resolves under the feed, with the notes intact', () => {
    const notes = '  indented first line\n- first: with a colon\n- "quoted" and #hash\n\n- after a blank line';
    const { text } = rewriteManifest(BUILT_MANIFEST, { version: '1.4.0', prefix: '/releases/v1.4.0/', notes });

    const info = parseUpdateInfo(text, 'latest-mac.yml', new URL('https://feed.example.test/latest-mac.yml'));
    expect(info.version).toBe('1.4.0');
    expect(info.releaseNotes).toBe(notes);

    const resolved = resolveFiles(info, new URL('https://feed.example.test/'));
    expect(resolved.map(file => file.url.href)).toEqual([
      'https://feed.example.test/releases/v1.4.0/Bike4Mind-1.4.0-arm64-mac.zip',
      'https://feed.example.test/releases/v1.4.0/Bike4Mind-1.4.0-mac.zip',
      'https://feed.example.test/releases/v1.4.0/Bike4Mind-1.4.0-arm64.dmg',
    ]);
  });

  it('replaces notes electron-builder already wrote instead of emitting a second key', () => {
    const withNotes = `${BUILT_MANIFEST}releaseNotes: |-\n  stale\n  notes\n`;
    const { text } = rewriteManifest(withNotes, { version: '1.4.0', prefix: 'releases/v1.4.0', notes: 'fresh' });
    expect(text.match(/releaseNotes/g)).toHaveLength(1);
    expect(text).not.toContain('stale');
    expect(parseUpdateInfo(text, 'latest-mac.yml', new URL('https://x.test/')).releaseNotes).toBe('fresh');
  });

  it('accepts CRLF input', () => {
    const { files } = rewriteManifest(BUILT_MANIFEST.replace(/\n/g, '\r\n'), {
      version: '1.4.0',
      prefix: 'releases/v1.4.0',
    });
    expect(files).toHaveLength(3);
  });

  it('refuses a manifest for a different version than the one being published', () => {
    expect(() => rewriteManifest(BUILT_MANIFEST, { version: '1.4.1', prefix: 'releases/v1.4.1' })).toThrow(
      /declares version 1.4.0, expected 1.4.1/
    );
  });

  it('refuses to rewrite a manifest that is already prefixed, or to publish into the root', () => {
    const { text } = rewriteManifest(BUILT_MANIFEST, { version: '1.4.0', prefix: 'releases/v1.4.0' });
    expect(() => rewriteManifest(text, { version: '1.4.0', prefix: 'releases/v1.4.0' })).toThrow(/bare file name/);
    expect(() => rewriteManifest(BUILT_MANIFEST, { version: '1.4.0', prefix: '/' })).toThrow(/empty prefix/);
  });

  it('refuses a manifest with no files', () => {
    expect(() => rewriteManifest('version: 1.4.0\n', { version: '1.4.0', prefix: 'releases/v1.4.0' })).toThrow(
      /no files/
    );
  });
});

describe('latestDmgName', () => {
  it('swaps the version for "latest", keeping the architecture', () => {
    expect(latestDmgName('release/Bike4Mind-1.4.0-arm64.dmg', '1.4.0')).toBe('Bike4Mind-latest-arm64.dmg');
    expect(latestDmgName('Bike4Mind-1.4.0-x64.dmg', '1.4.0')).toBe('Bike4Mind-latest-x64.dmg');
  });

  it('refuses a name that does not carry the version, so a stale dmg never becomes "latest"', () => {
    expect(() => latestDmgName('Bike4Mind-1.3.0-arm64.dmg', '1.4.0')).toThrow(/does not carry version/);
    expect(() => latestDmgName('Bike4Mind-1.4.0-arm64-mac.zip', '1.4.0')).toThrow(/does not carry version/);
  });
});

describe('isAheadOfLive', () => {
  it('treats no live manifest as the first release', () => {
    expect(isAheadOfLive('0.1.0', null)).toEqual({ ahead: true, live: null });
    expect(isAheadOfLive('0.1.0', '  ')).toEqual({ ahead: true, live: null });
  });

  it('only allows a strictly newer version over the live one', () => {
    expect(isAheadOfLive('1.4.1', BUILT_MANIFEST)).toEqual({ ahead: true, live: '1.4.0' });
    expect(isAheadOfLive('1.4.0', BUILT_MANIFEST)).toEqual({ ahead: false, live: '1.4.0' });
    expect(isAheadOfLive('1.3.9', BUILT_MANIFEST)).toEqual({ ahead: false, live: '1.4.0' });
  });

  it('fails closed on a live manifest it cannot read a version from', () => {
    expect(() => isAheadOfLive('1.4.1', '<html>not a manifest</html>')).toThrow(/names no version/);
  });
});

describe('the CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function sandbox(): string {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-release-'));
    dirs.push(dir);
    return dir;
  }

  it('reads the version from the desktop package', () => {
    expect(main(['version'])).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints notes, and fails naming the version when the section is missing', () => {
    const dir = sandbox();
    const changelog = join(dir, 'CHANGELOG.md');
    writeFileSync(changelog, CHANGELOG);
    expect(main(['notes', '--version', '1.3.1', '--changelog', changelog])).toBe(`${MAINTENANCE_NOTE}\n`);
    expect(() => main(['notes', '--version', '9.9.9', '--changelog', changelog])).toThrow(/no "## 9.9.9" section/);
    expect(() => main(['notes', '--version', '1.0.0', '--changelog', join(dir, 'missing.md')])).toThrow(/no changelog/);
  });

  it('writes the rewritten manifest and lists the files it needs uploaded', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'in.yml'), BUILT_MANIFEST);
    writeFileSync(join(dir, 'notes.md'), '- a note\n');
    const listed = main([
      'manifest',
      '--version',
      '1.4.0',
      '--prefix',
      'releases/v1.4.0',
      '--in',
      join(dir, 'in.yml'),
      '--out',
      join(dir, 'out.yml'),
      '--notes-file',
      join(dir, 'notes.md'),
    ]);
    expect(listed.trim().split('\n')).toHaveLength(3);
    expect(readFileSync(join(dir, 'out.yml'), 'utf8')).toContain('releaseNotes: |2-\n  - a note\n');
  });

  it('refuses to publish a version that is not ahead of the live feed', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'live.yml'), BUILT_MANIFEST);
    expect(main(['ahead', '--version', '1.5.0', '--live', join(dir, 'live.yml')])).toBe('1.4.0\n');
    expect(main(['ahead', '--version', '0.0.1'])).toBe('(nothing published yet)\n');
    expect(() => main(['ahead', '--version', '1.4.0', '--live', join(dir, 'live.yml')])).toThrow(
      /already serves 1.4.0/
    );
  });

  it('rejects a flag with no value and an unknown command', () => {
    expect(() => main(['notes', '--version'])).toThrow(/needs a value/);
    expect(() => main(['publish'])).toThrow(/usage/);
  });
});
