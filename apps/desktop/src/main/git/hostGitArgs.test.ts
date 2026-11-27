import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  gitArgumentPath,
  gitCommand,
  hostGitArgs,
  hostNetworkGitArgs,
  hostWorkTreeGitArgs,
  RepositoryFilterError,
  UnpinnableGitConfigError,
  type ScopedConfigReader,
} from './hostGitArgs';

vi.mock('../chat/tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../chat/tools/userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  hostProgram: async (name: string) => name,
}));

describe('hostGitArgs', () => {
  it('prefixes the config overrides and keeps the args in order', () => {
    const args = hostGitArgs(['status', '--porcelain']);
    expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    expect(args.slice(2, 4)[0]).toBe('-c');
    expect(args[3]).toMatch(/^core\.hooksPath=(\/dev\/null|NUL)$/);
    expect(args.slice(4)).toEqual(['status', '--porcelain']);
  });

  it.skipIf(process.platform === 'win32')('does not run a repo-configured fsmonitor command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-git-'));
    try {
      const marker = join(dir, 'marker');
      const script = join(dir, 'monitor.sh');
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(script, 0o755);
      const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      run(['init', '--quiet']);
      run(['config', 'core.fsmonitor', script]);
      run(hostGitArgs(['status', '--porcelain']));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('runs no filter or diff program the repository config sets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-git-'));
    try {
      const marker = join(dir, 'marker');
      const script = join(dir, 'filter.sh');
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
      chmodSync(script, 0o755);
      const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      run(['init', '--quiet']);
      writeFileSync(join(dir, 'file.txt'), 'one\n');
      run(['add', 'file.txt']);
      run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'first']);
      run(['config', 'filter.evil.clean', script]);
      run(['config', 'filter.evil.process', script]);
      run(['config', 'filter.evil.required', 'true']);
      run(['config', 'diff.evil.textconv', script]);
      writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n');
      writeFileSync(join(dir, 'file.txt'), 'two\n');
      run(await hostWorkTreeGitArgs(['status', '--porcelain'], dir));
      run(await hostWorkTreeGitArgs(['diff', '--numstat', 'HEAD', '--'], dir));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs no filter or diff program a checked-out submodule config sets, nested ones included',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'host-git-'));
      try {
        const marker = join(dir, 'marker');
        const script = join(dir, 'filter.sh');
        writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
        chmodSync(script, 0o755);
        const git = (cwd: string, args: string[]) =>
          execFileSync(
            'git',
            ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'protocol.file.allow=always', ...args],
            { cwd, stdio: 'ignore' }
          );
        const repo = (name: string) => {
          const path = join(dir, name);
          mkdirSync(path);
          git(path, ['init', '--quiet']);
          writeFileSync(join(path, 'file.txt'), 'one\n');
          git(path, ['add', 'file.txt']);
          git(path, ['commit', '--quiet', '-m', 'first']);
          return path;
        };
        const inner = repo('inner');
        const middle = repo('middle');
        git(middle, ['submodule', 'add', '--quiet', inner, 'inner']);
        git(middle, ['commit', '--quiet', '-m', 'inner']);
        const top = repo('top');
        git(top, ['submodule', 'add', '--quiet', middle, 'mods/middle']);
        git(top, ['submodule', 'update', '--init', '--recursive', '--quiet']);
        mkdirSync(join(top, 'src'));
        const checkouts = [join(top, 'mods', 'middle'), join(top, 'mods', 'middle', 'inner')];
        for (const checkout of checkouts) {
          git(checkout, ['config', 'filter.evil.clean', script]);
          git(checkout, ['config', 'diff.evil.textconv', script]);
          writeFileSync(join(checkout, '.gitattributes'), '* filter=evil diff=evil\n');
          writeFileSync(join(checkout, 'file.txt'), 'two\n');
        }
        const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

        for (const cwd of [top, join(top, 'src')]) {
          run(cwd, await hostWorkTreeGitArgs(['status', '--porcelain'], cwd));
          run(cwd, await hostWorkTreeGitArgs(['diff', '--numstat', 'HEAD', '--'], cwd));
          run(cwd, await hostWorkTreeGitArgs(['diff', '--submodule=diff', 'HEAD', '--'], cwd));
        }
        expect(existsSync(marker)).toBe(false);
        // The same status without the submodule pins does run the program.
        run(top, hostGitArgs(['status', '--porcelain'], top));
        expect(existsSync(marker)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  async function withFilteredSubmodule(
    run: (fixture: {
      top: string;
      child: string;
      globalConfig: string;
      git: (cwd: string, args: string[]) => string;
    }) => Promise<void>
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'host-git-recursion-'));
    const globalConfig = join(directory, 'global.config');
    writeFileSync(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const git = (cwd: string, args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'protocol.file.allow=always',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    try {
      const source = join(directory, 'source');
      const top = join(directory, 'top');
      mkdirSync(source);
      mkdirSync(top);
      git(source, ['init', '--quiet', '--initial-branch=main']);
      git(source, ['config', 'filter.crypt.clean', 'sed s/^/ENC:/']);
      git(source, ['config', 'filter.crypt.smudge', 'sed s/^ENC://']);
      writeFileSync(join(source, '.gitattributes'), 'secret.txt filter=crypt\n');
      writeFileSync(join(source, 'secret.txt'), 'v1\n');
      git(source, ['add', '.']);
      git(source, ['commit', '--quiet', '-m', 'one']);
      const first = git(source, ['rev-parse', 'HEAD']);
      writeFileSync(join(source, 'secret.txt'), 'v2\n');
      git(source, ['add', '.']);
      git(source, ['commit', '--quiet', '-m', 'two']);
      const second = git(source, ['rev-parse', 'HEAD']);
      git(top, ['init', '--quiet', '--initial-branch=main']);
      git(top, ['submodule', 'add', '--quiet', source, 's']);
      const child = join(top, 's');
      git(child, ['config', 'filter.crypt.clean', 'sed s/^/ENC:/']);
      git(child, ['config', 'filter.crypt.smudge', 'sed s/^ENC://']);
      git(child, ['reset', '--hard', first]);
      git(top, ['add', '.']);
      git(top, ['commit', '--quiet', '-m', 'first child']);
      git(top, ['switch', '--quiet', '-c', 'other']);
      git(child, ['reset', '--hard', second]);
      git(top, ['add', 's']);
      git(top, ['commit', '--quiet', '-m', 'second child']);
      git(top, ['switch', '--quiet', '--no-recurse-submodules', 'main']);
      git(child, ['reset', '--hard', first]);
      // A non-racy index lets Git trust the clean snapshot before the app pins its filter.
      utimesSync(join(child, 'secret.txt'), new Date(0), new Date(0));
      git(child, ['update-index', '--refresh']);
      await run({ top, child, globalConfig, git });
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === 'win32')(
    'refuses a recursive switch before it can write a submodule stored bytes',
    async () => {
      await withFilteredSubmodule(async ({ top, child, globalConfig, git }) => {
        git(top, ['config', '--file', globalConfig, 'submodule.recurse', 'true']);
        let refused = false;
        try {
          git(top, await hostWorkTreeGitArgs(['switch', '--quiet', '--no-guess', 'other'], top));
        } catch (error) {
          if (!(error instanceof RepositoryFilterError)) throw error;
          refused = true;
        }
        expect({ refused, content: readFileSync(join(child, 'secret.txt'), 'utf8') }).toEqual({
          refused: true,
          content: 'v1\n',
        });
      });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses incompatible trusted driver values from a child conditional include',
    async () => {
      await withFilteredSubmodule(async ({ top, child, globalConfig, git }) => {
        const trustedConfig = join(top, '..', 'child-trusted.config');
        git(top, ['config', '--file', trustedConfig, 'filter.crypt.clean', 'sed s/^/ENC:/']);
        git(top, ['config', '--file', trustedConfig, 'filter.crypt.smudge', 'sed s/^ENC://']);
        git(top, ['config', '--file', globalConfig, 'includeIf.gitdir:**/modules/s.path', trustedConfig]);
        // The user configured the trusted value only for this child, so one shared -c value cannot preserve both contexts.
        expect(git(child, ['config', '--show-scope', '--get-all', 'filter.crypt.smudge'])).toContain('global');
        await expect(hostWorkTreeGitArgs(['status', '--porcelain'], top)).rejects.toThrow(UnpinnableGitConfigError);
      });
    }
  );

  describe('hostWorkTreeGitArgs', () => {
    const read = (entries: Array<[string, string, string]>) => async () =>
      entries.map(([scope, key, value]) => ({ scope, key, value }));

    it('pins a driver the repository redefines to the global value, and empties one only it defines', async () => {
      const args = await hostWorkTreeGitArgs(
        ['status'],
        '/repo',
        read([
          ['global', 'filter.lfs.process', 'git-lfs filter-process'],
          ['local', 'filter.lfs.process', 'touch marker'],
          ['local', 'filter.evil.clean', 'touch marker'],
          ['local', 'filter.evil.required', 'true'],
        ])
      );
      expect(args).toContain('filter.lfs.process=git-lfs filter-process');
      expect(args).toContain('filter.evil.clean=');
      expect(args).toContain('filter.evil.required=false');
      expect(args.at(-1)).toBe('status');
    });

    it('adds nothing for drivers only the user config sets', async () => {
      const args = await hostWorkTreeGitArgs(
        ['status'],
        '/repo',
        read([['global', 'filter.lfs.clean', 'git-lfs clean']])
      );
      expect(args).toEqual(hostGitArgs(['status'], '/repo'));
    });

    it('refuses a call that writes work-tree files while a filter only the repository sets is emptied', async () => {
      const repoOnly = read([['local', 'filter.crypt.smudge', 'git-crypt smudge']]);
      for (const args of [
        ['switch', 'main'],
        ['checkout', 'main'],
        ['worktree', 'add', '../wt', 'main'],
        ['stash', 'pop'],
      ]) {
        await expect(hostWorkTreeGitArgs(args, '/repo', repoOnly)).rejects.toThrow(RepositoryFilterError);
      }
      // Reads, a worktree removal, and a filter the user's own config also sets still run.
      await expect(hostWorkTreeGitArgs(['status'], '/repo', repoOnly)).resolves.toContain('filter.crypt.smudge=');
      await expect(hostWorkTreeGitArgs(['worktree', 'remove', '../wt'], '/repo', repoOnly)).resolves.toBeDefined();
      await expect(
        hostWorkTreeGitArgs(
          ['switch', 'main'],
          '/repo',
          read([
            ['global', 'filter.lfs.smudge', 'git-lfs smudge -- %f'],
            ['local', 'filter.lfs.smudge', 'touch marker'],
            ['local', 'diff.x.textconv', 'touch marker'],
          ])
        )
      ).resolves.toContain('filter.lfs.smudge=git-lfs smudge -- %f');
    });

    it('pins a filter only a submodule sets for an explicitly non-recursive write', async () => {
      const args = await hostWorkTreeGitArgs(['switch', '--no-recurse-submodules', 'main'], '/repo', async () => [
        { scope: 'local', key: 'filter.crypt.smudge', value: 'git-crypt smudge', submodule: true },
      ]);
      expect(args).toContain('filter.crypt.smudge=');
    });

    it.each(['switch', 'checkout', 'reset', 'restore', 'read-tree'])(
      'guards recursive %s writes and pins an admitted non-recursive mode',
      async command => {
        const readChild = async () => [
          { scope: 'local', key: 'filter.crypt.smudge', value: 'untrusted', submodule: true },
        ];
        await expect(
          hostWorkTreeGitArgs([command, 'main'], '/repo', readChild, process.platform, async () => true)
        ).rejects.toThrow(RepositoryFilterError);
        await expect(
          hostWorkTreeGitArgs([command, 'main'], '/repo', readChild, process.platform, async () => null)
        ).rejects.toThrow(UnpinnableGitConfigError);
        await expect(
          hostWorkTreeGitArgs([command, 'main'], '/repo', readChild, process.platform, async () => false)
        ).resolves.toContain('submodule.recurse=false');
      }
    );

    it('honors explicit recursion options in order and does not parse options after the path separator', async () => {
      const readChild = async () => [
        { scope: 'local', key: 'filter.crypt.smudge', value: 'untrusted', submodule: true },
      ];
      const readRecursion = vi.fn(async () => true);
      for (const args of [
        ['switch', '--no-recurse-submodules', 'main'],
        ['switch', '--recurse-submodules=false', 'main'],
        ['switch', '--recurse-submodules', '--no-recurse-submodules', 'main'],
      ])
        await expect(hostWorkTreeGitArgs(args, '/repo', readChild, process.platform, readRecursion)).resolves.toContain(
          'submodule.recurse=false'
        );
      expect(readRecursion).not.toHaveBeenCalled();
      await expect(
        hostWorkTreeGitArgs(
          ['switch', '--no-recurse-submodules', '--recurse-submodules', 'main'],
          '/repo',
          readChild,
          process.platform,
          async () => false
        )
      ).rejects.toThrow(RepositoryFilterError);
      await expect(
        hostWorkTreeGitArgs(
          ['restore', '--', '--no-recurse-submodules'],
          '/repo',
          readChild,
          process.platform,
          readRecursion
        )
      ).rejects.toThrow(RepositoryFilterError);
      for (const command of ['status', 'diff', 'stash', 'merge']) {
        const unused = vi.fn(async () => true);
        await expect(
          hostWorkTreeGitArgs([command], '/repo', readChild, process.platform, unused)
        ).resolves.toBeDefined();
        expect(unused).not.toHaveBeenCalled();
      }
    });

    it('refuses when the settings cannot be read or a name cannot be pinned', async () => {
      await expect(hostWorkTreeGitArgs(['status'], '/repo', async () => null)).rejects.toThrow();
      await expect(
        hostWorkTreeGitArgs(['status'], '/repo', read([['local', 'filter.a=b.clean', 'touch marker']]))
      ).rejects.toThrow();
    });
  });

  describe('hostNetworkGitArgs', () => {
    const config =
      (entries: Array<[string, string, string]>): ScopedConfigReader =>
      async () =>
        entries.map(([scope, key, value]) => ({ scope, key, value }));
    const helperArgs = (args: string[]) => args.filter(a => /^credential\..*helper=/.test(a));

    it('keeps only trusted credential helpers, in order, after a reset', async () => {
      const read = config([
        ['unknown', 'credential.helper', 'osxkeychain'],
        ['system', 'credential.helper', 'manager'],
        ['global', 'credential.helper', 'store'],
        ['local', 'credential.helper', '!touch marker'],
      ]);
      const args = await hostNetworkGitArgs(['fetch'], '/repo', read, {});
      expect(helperArgs(args)).toEqual([
        'credential.helper=',
        'credential.helper=osxkeychain',
        'credential.helper=manager',
        'credential.helper=store',
      ]);
      expect(args.at(-1)).toBe('fetch');
    });

    it('replays URL-scoped global helpers verbatim, empty resets included, and drops local ones', async () => {
      const read = config([
        ['global', 'credential.helper', 'osxkeychain'],
        ['global', 'credential.https://github.com.helper', ''],
        ['global', 'credential.https://github.com.helper', '!gh auth git-credential'],
        ['local', 'credential.https://github.com.helper', '!touch marker'],
      ]);
      expect(helperArgs(await hostNetworkGitArgs(['fetch'], '/repo', read, {}))).toEqual([
        'credential.helper=',
        'credential.helper=osxkeychain',
        'credential.https://github.com.helper=',
        'credential.https://github.com.helper=!gh auth git-credential',
      ]);
    });

    it('refuses the transports that would run an upload-pack or proxy program the repo sets', async () => {
      const plain = await hostNetworkGitArgs(['fetch'], '/repo', config([]), {});
      expect(plain).toContain('protocol.ext.allow=never');
      expect(plain).not.toContain('protocol.file.allow=never');
      const set = await hostNetworkGitArgs(
        ['fetch'],
        '/repo',
        config([
          ['local', 'remote.origin.uploadpack', 'touch marker'],
          ['local', 'core.gitproxy', 'touch marker'],
        ]),
        {}
      );
      expect(set).toContain('protocol.file.allow=never');
      expect(set).toContain('protocol.git.allow=never');
    });

    it('leaves sshCommand and askPass alone when the repo does not set them', async () => {
      const read = config([['global', 'core.sshcommand', 'ssh -i key']]);
      const args = await hostNetworkGitArgs(['fetch'], '/repo', read, {});
      expect(args.some(a => a.startsWith('core.sshCommand=') || a.startsWith('core.askPass='))).toBe(false);
    });

    it('pins sshCommand and askPass to the global value when the repo sets them', async () => {
      const read = config([
        ['global', 'core.sshcommand', 'ssh -i key'],
        ['local', 'core.sshcommand', 'touch marker'],
        ['global', 'core.askpass', '/usr/bin/askpass'],
        ['local', 'core.askpass', 'touch marker'],
      ]);
      const args = await hostNetworkGitArgs(['fetch'], '/repo', read, {});
      expect(args).toContain('core.sshCommand=ssh -i key');
      expect(args).toContain('core.askPass=/usr/bin/askpass');
    });

    it('falls back to ssh and SSH_ASKPASS, and defers to GIT_SSH_COMMAND and GIT_ASKPASS', async () => {
      const read = config([
        ['local', 'core.sshcommand', 'touch marker'],
        ['local', 'core.askpass', 'touch marker'],
      ]);
      const pinned = await hostNetworkGitArgs(['fetch'], '/repo', read, { SSH_ASKPASS: '/bin/ask' });
      expect(pinned).toContain('core.sshCommand=ssh');
      expect(pinned).toContain('core.askPass=/bin/ask');
      expect(await hostNetworkGitArgs(['fetch'], '/repo', read, {})).toContain('core.askPass=');
      const withEnv = await hostNetworkGitArgs(['fetch'], '/repo', read, {
        GIT_SSH_COMMAND: 'ssh -v',
        GIT_ASKPASS: '/bin/ask',
      });
      expect(withEnv.some(a => a.startsWith('core.sshCommand=') || a.startsWith('core.askPass='))).toBe(false);
    });

    it('in a WSL folder, reads only the variables that cross into Linux, and uses its null device', async () => {
      const read = config([
        ['local', 'core.sshcommand', 'touch marker'],
        ['local', 'core.askpass', 'touch marker'],
      ]);
      const wsl = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';
      const hostOnly = { GIT_SSH_COMMAND: 'ssh -v', GIT_ASKPASS: 'C:\\ask.exe', SSH_ASKPASS: 'C:\\ask.exe' };
      const pinned = await hostNetworkGitArgs(['fetch'], wsl, read, hostOnly, 'win32');
      expect(pinned).toContain('core.sshCommand=ssh');
      expect(pinned).toContain('core.askPass=');
      expect(pinned).toContain('core.hooksPath=/dev/null');

      const crossing = { ...hostOnly, WSLENV: 'GIT_SSH_COMMAND/u:SSH_ASKPASS' };
      const deferred = await hostNetworkGitArgs(['fetch'], wsl, read, crossing, 'win32');
      expect(deferred.some(a => a.startsWith('core.sshCommand='))).toBe(false);
      expect(deferred).toContain('core.askPass=C:\\ask.exe');

      const outbound = { ...hostOnly, WSLENV: 'GIT_SSH_COMMAND/w:GIT_ASKPASS/pw' };
      const ignored = await hostNetworkGitArgs(['fetch'], wsl, read, outbound, 'win32');
      expect(ignored).toContain('core.sshCommand=ssh');
      expect(ignored).toContain('core.askPass=');
    });

    describe('git in a WSL folder', () => {
      const wsl = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

      it('runs Linux git through wsl.exe in the folder, with Linux path arguments', async () => {
        const worktree = gitArgumentPath(wsl, '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt', 'win32');
        expect(worktree).toBe('/home/me/wt');
        const command = await gitCommand(wsl, hostGitArgs(['worktree', 'add', worktree], wsl, 'win32'), 'win32');
        expect(command?.file).toMatch(/^[A-Z]:\\.*\\System32\\wsl\.exe$/i);
        expect(command?.cwd).toBeUndefined();
        expect(command?.args.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
        expect(command?.args.slice(-9)).toEqual([
          '/home/me/repo',
          'git',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          'worktree',
          'add',
          '/home/me/wt',
        ]);
      });

      it('leaves other folders, other distros and other hosts alone', async () => {
        expect(await gitCommand('C:\\repo', ['status'], 'win32')).toEqual({
          file: 'git',
          args: ['status'],
          cwd: 'C:\\repo',
        });
        expect((await gitCommand(wsl, ['status'], 'linux'))?.file).toBe('git');
        expect(gitArgumentPath(wsl, '\\\\wsl.localhost\\Debian\\x', 'win32')).toBe('\\\\wsl.localhost\\Debian\\x');
        expect(gitArgumentPath(wsl, '\\\\wsl.localhost\\Ubuntu\\x', 'linux')).toBe('\\\\wsl.localhost\\Ubuntu\\x');
      });
    });

    it.skipIf(process.platform === 'win32')('still fills a credential from a URL-scoped global helper', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'host-git-cred-'));
      const previous = process.env.GIT_CONFIG_GLOBAL;
      try {
        const globalConfig = join(dir, 'gitconfig');
        writeFileSync(
          globalConfig,
          '[credential "https://example.invalid"]\n\thelper =\n\thelper = "!f() { echo username=u; echo password=from-global; }; f"\n'
        );
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
        execFileSync('git', ['config', 'credential.https://example.invalid.helper', '!touch marker'], { cwd: dir });
        const out = execFileSync('git', await hostNetworkGitArgs(['credential', 'fill'], dir, undefined, {}), {
          cwd: dir,
          input: 'protocol=https\nhost=example.invalid\n\n',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }).toString();
        expect(out).toContain('password=from-global');
        expect(existsSync(join(dir, 'marker'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('does not run a repo-local sshCommand during fetch', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'host-git-net-'));
      try {
        const marker = join(dir, 'marker');
        const script = join(dir, 'ssh.sh');
        writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        chmodSync(script, 0o755);
        const run = (args: string[]) => {
          try {
            execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 10000 });
          } catch {
            // the fetch itself is expected to fail
          }
        };
        run(['init', '--quiet']);
        run(['remote', 'add', 'origin', 'ssh://git@example.invalid/r.git']);
        run(['config', 'core.sshCommand', script]);
        run(await hostNetworkGitArgs(['fetch', 'origin'], dir, undefined, {}));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
