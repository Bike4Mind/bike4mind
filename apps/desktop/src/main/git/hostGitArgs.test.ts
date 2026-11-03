import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitArgumentPath, gitCommand, hostGitArgs, hostNetworkGitArgs, type ScopedConfigReader } from './hostGitArgs';

vi.mock('../chat/tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('../chat/tools/userPath')>()),
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
        expect(command?.file).toBe('wsl.exe');
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
