import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { gitRemoteSettings, gitRemoteUrls, inPlaceWrites } from './shellWrites';

// The git subcommand branches read no syntax node.
const noNode = null as unknown as Node;

describe('git write scan on a subcommand word that is not plain text', () => {
  it.each(['cle?n', 'cle[a]n', 'cl$x', 'cl`x`', 'c{l,}ean', 'c\\lean', "cle''an", 'cle"an"', '*', '?'])(
    'leaves the paths of `git %s -fdx` unread',
    async sub => {
      const writes = await inPlaceWrites(['git', sub, '-fdx'], noNode, '/nonexistent/project');
      expect(writes.unread).toBe(true);
    }
  );

  it.each(['-C . ', '-c core.pager=cat ', '--no-pager '])(
    'leaves the paths of `git %scle?n -fdx` unread',
    async options => {
      const writes = await inPlaceWrites(
        ['git', ...options.trim().split(' '), 'cle?n', '-fdx'],
        noNode,
        '/nonexistent/project'
      );
      expect(writes.unread).toBe(true);
    }
  );

  it.each([
    ['--git-dir', 'main'],
    ['--work-tree', 'main'],
    ['--namespace', 'main'],
    ['--config-env', 'core.x=main'],
    ['--attr-source', 'main'],
    ['--attr-source', 'HEAD'],
    ['--super-prefix', 'main'],
    ['--shallow-file', 'main'],
  ])(
    'leaves the paths of `git %s %s clean -fdx` unread, as a separate value and as a glued one',
    async (option, value) => {
      for (const words of [
        [option, value],
        [`${option}=${value}`],
        ['-C', '.', option, value],
        ['-c', 'core.x=y', option, value],
      ]) {
        const writes = await inPlaceWrites(['git', ...words, 'clean', '-fdx'], noNode, '/nonexistent/project');
        expect(writes.unread).toBe(true);
      }
    }
  );

  it.each([
    ['--future-option', 'main'],
    ['--no-pager', 'HEAD'],
    ['--no-pager', './x'],
    ['--bare', 'Main'],
  ])('leaves the paths of `git %s %s clean -fdx` unread, as a word that is no command name', async (option, word) => {
    const writes = await inPlaceWrites(['git', option, word, 'clean', '-fdx'], noNode, '/nonexistent/project');
    expect(writes.unread).toBe(true);
  });

  it.each(['--version', '-v', '--help', '-h'])('reads `git %s clean -fdx` as writing nothing', async option => {
    const writes = await inPlaceWrites(['git', option, 'clean', '-fdx'], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
    expect(writes.files).toEqual([]);
  });

  it.each([
    ['--no-pager'],
    ['-C', '.'],
    ['-c', 'core.x=y'],
    ['--exec-path'],
    ['--no-literal-pathspecs'],
    ['--literal-pathspecs'],
    ['--glob-pathspecs'],
    ['--noglob-pathspecs'],
    ['--icase-pathspecs'],
    ['--no-replace-objects'],
    ['--no-lazy-fetch'],
    ['--no-advice'],
    ['--no-optional-locks'],
  ])('reads `git %s status` as writing nothing', async (...words) => {
    const writes = await inPlaceWrites(['git', ...words, 'status'], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
  });

  it.each(['status', 'log', 'diff'])('reads `git %s` as writing nothing', async sub => {
    const writes = await inPlaceWrites(['git', sub], noNode, '/nonexistent/project');
    expect(writes.unread).toBeUndefined();
  });
});

describe('remote settings read from a repository', () => {
  let base = '';
  let repo = '';

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-remotes-')));
    repo = join(base, 'repo');
    vi.stubEnv('HOME', base);
    vi.stubEnv('XDG_CONFIG_HOME', join(base, '.config'));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args]);
    };
    execFileSync('git', ['init', '-q', repo]);
    git('remote', 'add', 'origin', 'https://example.com/r.git');
    git('config', 'remote.origin.pushurl', `ext::sh -c touch% ${join(base, 'MARK')}`);
    git('remote', 'add', 'svn', 'https://example.com/s');
    git('config', 'remote.svn.vcs', 'svn');
    git('config', 'url.foo::x.insteadOf', 'https://example.com/');
    git('config', 'url.git@example.com:.pushInsteadOf', 'https://example.com/');
    git('config', 'remotes.Grp', 'origin foo::y');
    git('config', 'branch.main.remote', 'svn');
    git('config', 'remote.pushDefault', '.');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('reads the remotes, their helper programs, the URL rewrites, the groups and the default remotes', async () => {
    expect(await gitRemoteSettings(repo)).toEqual({
      remotes: ['origin', 'svn'],
      helpers: ['svn'],
      rewrites: [
        { base: 'foo::x', prefix: 'https://example.com/', push: false },
        { base: 'git@example.com:', prefix: 'https://example.com/', push: true },
      ],
      outside: false,
      groups: [{ name: 'grp', members: ['origin', 'foo::y'] }],
      defaults: ['origin', 'foo::y', 'svn', '.'],
    });
  });

  it('reads the URLs git would fetch from and push to, and runs nothing they name', async () => {
    expect(await gitRemoteUrls(repo, 'origin', false)).toEqual(['foo::xr.git']);
    expect(await gitRemoteUrls(repo, 'origin', true)).toEqual([`ext::sh -c touch% ${join(base, 'MARK')}`]);
    expect(await gitRemoteUrls(repo, 'nosuch', false)).toBe('none');
    expect(existsSync(join(base, 'MARK'))).toBe(false);
  });

  it('reads the user config alone outside a repository', async () => {
    const home = join(base, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '[remote "up"]\n\turl = foo::x\n[remote "origin"]\n\tvcs = svn\n');
    vi.stubEnv('HOME', home);
    try {
      expect(await gitRemoteSettings(base)).toEqual({
        remotes: ['up'],
        helpers: ['origin'],
        rewrites: [],
        outside: true,
        groups: [],
        defaults: [],
      });
    } finally {
      vi.stubEnv('HOME', base);
    }
  });
});
