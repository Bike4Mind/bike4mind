import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  globSegmentPattern,
  listSshHosts,
  MAX_INCLUDE_DEPTH,
  parseSshConfig,
  tokenizeSshConfigLine,
  type SshConfigFileSystem,
} from './sshConfig';

const HOME = '/home/rider';

/** An in-memory tree: file paths to their text; directories are implied by the paths. */
function memoryFs(files: Record<string, string>): SshConfigFileSystem {
  return {
    readFile: async path => files[path] ?? null,
    readdir: async directory => {
      const prefix = directory.endsWith('/') ? directory : `${directory}/`;
      const entries = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) entries.add(path.slice(prefix.length).split('/')[0]);
      }
      return entries.size === 0 ? null : [...entries];
    },
    realpath: async path => posix.normalize(path),
  };
}

const list = (files: Record<string, string>) => listSshHosts({ home: HOME, fs: memoryFs(files) });
const config = (text: string) => ({ [`${HOME}/.ssh/config`]: text });

describe('tokenizeSshConfigLine', () => {
  it.each([
    ['Host devbox', { keyword: 'host', args: ['devbox'] }],
    ['  HOST   a   b  ', { keyword: 'host', args: ['a', 'b'] }],
    ['Host=devbox', { keyword: 'host', args: ['devbox'] }],
    ['Host = devbox other', { keyword: 'host', args: ['devbox', 'other'] }],
    ['Include "with space/*.conf" plain', { keyword: 'include', args: ['with space/*.conf', 'plain'] }],
    ['\tHostName devbox.example.test', { keyword: 'hostname', args: ['devbox.example.test'] }],
    ['Host a b # work laptop', { keyword: 'host', args: ['a', 'b'] }],
    ['Host a #comment', { keyword: 'host', args: ['a'] }],
    ['Include "#quoted.conf"', { keyword: 'include', args: ['#quoted.conf'] }],
  ])('%j', (line, expected) => {
    expect(tokenizeSshConfigLine(line)).toEqual(expected);
  });

  it.each(['', '   ', '# Host commented', '   # indented comment'])('skips %j', line => {
    expect(tokenizeSshConfigLine(line)).toBeNull();
  });
});

describe('parseSshConfig', () => {
  it('keeps Host and Include lines and skips Match blocks up to the next Host', () => {
    const text = [
      'Include common.conf',
      'Host a b',
      '  HostName a.example.test',
      '  Include in-host.conf',
      'Match host c exec "true"',
      '  Include in-match.conf',
      '  HostName c.example.test',
      'Host d',
      '  Include after-match.conf',
    ].join('\n');
    expect(parseSshConfig(text)).toEqual([
      { kind: 'include', paths: ['common.conf'] },
      { kind: 'host', names: ['a', 'b'] },
      { kind: 'include', paths: ['in-host.conf'] },
      { kind: 'host', names: ['d'] },
      { kind: 'include', paths: ['after-match.conf'] },
    ]);
  });
});

describe('globSegmentPattern', () => {
  it.each<[string, string, boolean]>([
    ['*.conf', 'work.conf', true],
    ['*.conf', 'work.conf.bak', false],
    ['*', '.hidden', false],
    ['.*', '.hidden', true],
    ['host?', 'host1', true],
    ['host?', 'host12', false],
    ['[ab].conf', 'a.conf', true],
    ['[!ab].conf', 'a.conf', false],
    ['[!ab].conf', 'c.conf', true],
    ['a+b(c).conf', 'a+b(c).conf', true],
  ])('%s against %s is %s', (pattern, name, matches) => {
    expect(globSegmentPattern(pattern).test(name)).toBe(matches);
  });
});

describe('listSshHosts', () => {
  it('lists concrete Host names in order, each once, without patterns or negations', async () => {
    const listing = await list(
      config(
        ['Host devbox gpu-box', 'Host *.internal !bastion web?', 'Host devbox build', 'Host *', '  User me'].join('\n')
      )
    );
    expect(listing).toEqual({ aliases: ['devbox', 'gpu-box', 'build'], problems: [] });
  });

  it('lists nothing when there is no config', async () => {
    expect(await list({})).toEqual({ aliases: [], problems: [] });
  });

  it('skips the hosts of a Match block, and an Include inside one', async () => {
    const listing = await list({
      ...config(['Match user root', '  Include matched.conf', 'Host after'].join('\n')),
      [`${HOME}/.ssh/matched.conf`]: 'Host only-when-matched',
    });
    expect(listing.aliases).toEqual(['after']);
  });

  it('follows Include relative to ~/.ssh, with ~ and absolute paths, in place', async () => {
    const listing = await list({
      ...config(['Host first', 'Include config.d/work ~/extra.conf /etc/ssh/shared.conf', 'Host last'].join('\n')),
      [`${HOME}/.ssh/config.d/work`]: 'Host work',
      [`${HOME}/extra.conf`]: 'Host extra',
      '/etc/ssh/shared.conf': 'Host shared',
    });
    expect(listing.aliases).toEqual(['first', 'work', 'extra', 'shared', 'last']);
  });

  it('expands globs in sorted order and leaves out dot files', async () => {
    const listing = await list({
      ...config('Include config.d/*'),
      [`${HOME}/.ssh/config.d/20-b`]: 'Host b',
      [`${HOME}/.ssh/config.d/10-a`]: 'Host a',
      [`${HOME}/.ssh/config.d/.swap`]: 'Host swap',
    });
    expect(listing.aliases).toEqual(['a', 'b']);
  });

  it('follows nested includes and ignores ones that do not exist', async () => {
    const listing = await list({
      ...config('Include one.conf missing.conf'),
      [`${HOME}/.ssh/one.conf`]: 'Host one\nInclude two.conf',
      [`${HOME}/.ssh/two.conf`]: 'Host two',
    });
    expect(listing).toEqual({ aliases: ['one', 'two'], problems: [] });
  });

  it.each([
    ['a file that includes itself', { [`${HOME}/.ssh/self.conf`]: 'Host self\nInclude self.conf' }, ['self']],
    [
      'two files that include each other',
      {
        [`${HOME}/.ssh/self.conf`]: 'Host a\nInclude other.conf',
        [`${HOME}/.ssh/other.conf`]: 'Host b\nInclude self.conf',
      },
      ['a', 'b'],
    ],
    ['an include of the main config', { [`${HOME}/.ssh/self.conf`]: 'Host loop\nInclude ~/.ssh/config' }, ['loop']],
  ])('stops at an Include cycle: %s', async (_what, files, aliases) => {
    const listing = await list({ ...config('Include self.conf'), ...files });
    expect(listing.aliases).toEqual(aliases);
    expect(listing.problems).toEqual([expect.stringContaining('Include cycle')]);
  });

  it('allows the same file twice when it is not a cycle', async () => {
    const listing = await list({
      ...config('Include a.conf b.conf'),
      [`${HOME}/.ssh/a.conf`]: 'Include common.conf',
      [`${HOME}/.ssh/b.conf`]: 'Include common.conf',
      [`${HOME}/.ssh/common.conf`]: 'Host common',
    });
    expect(listing).toEqual({ aliases: ['common'], problems: [] });
  });

  it(`stops nesting at ${MAX_INCLUDE_DEPTH} levels`, async () => {
    const files: Record<string, string> = config('Include level-1.conf');
    for (let level = 1; level <= MAX_INCLUDE_DEPTH + 2; level += 1) {
      files[`${HOME}/.ssh/level-${level}.conf`] = `Host level-${level}\nInclude level-${level + 1}.conf`;
    }
    const listing = await list(files);
    expect(listing.aliases).toHaveLength(MAX_INCLUDE_DEPTH - 1);
    expect(listing.problems).toEqual([expect.stringContaining('nested deeper')]);
  });

  it('reports names that cannot be used as an alias instead of listing them', async () => {
    const listing = await list(config('Host good -oProxyCommand=id .dot'));
    expect(listing.aliases).toEqual(['good']);
    expect(listing.problems).toHaveLength(2);
  });

  describe('on disk', () => {
    let home = '';
    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'b4m-ssh-config-'));
      await mkdir(join(home, '.ssh', 'config.d'), { recursive: true });
      await writeFile(join(home, '.ssh', 'config'), 'Host disk\nInclude config.d/*.conf\n');
      await writeFile(join(home, '.ssh', 'config.d', 'a.conf'), 'Host linked\nInclude loop.conf\n');
      // A symlink back to the main config: a cycle only realpath can see.
      await symlink(join(home, '.ssh', 'config'), join(home, '.ssh', 'loop.conf'));
    });
    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('reads real files, expands globs and sees a cycle through a symlink', async () => {
      const listing = await listSshHosts({ home });
      expect(listing.aliases).toEqual(['disk', 'linked']);
      expect(listing.problems).toEqual([expect.stringContaining('Include cycle')]);
    });
  });
});
