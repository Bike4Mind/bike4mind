import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostGitArgs, hostNetworkGitArgs, type ScopedConfigReader } from './hostGitArgs';

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
      (values: Record<string, Array<[string, string]>>): ScopedConfigReader =>
      async (_cwd, key) =>
        (values[key] ?? []).map(([scope, value]) => ({ scope, value }));

    it('keeps only system and global credential helpers, in order, after a reset', async () => {
      const read = config({
        'credential.helper': [
          ['system', 'osxkeychain'],
          ['global', 'store'],
          ['local', '!touch marker'],
        ],
      });
      const args = await hostNetworkGitArgs(['fetch'], '/repo', read, {});
      const helpers = args.filter(a => a.startsWith('credential.helper='));
      expect(helpers).toEqual(['credential.helper=', 'credential.helper=osxkeychain', 'credential.helper=store']);
      expect(args.at(-1)).toBe('fetch');
    });

    it('takes sshCommand and askPass from the global scope, ignoring local', async () => {
      const read = config({
        'core.sshCommand': [
          ['global', 'ssh -i key'],
          ['local', 'touch marker'],
        ],
        'core.askPass': [['local', 'touch marker']],
      });
      const args = await hostNetworkGitArgs(['fetch'], '/repo', read, {});
      expect(args).toContain('core.sshCommand=ssh -i key');
      expect(args).toContain('core.askPass=');
    });

    it('defaults sshCommand to ssh and leaves it to GIT_SSH_COMMAND when that is set', async () => {
      const read = config({ 'core.sshCommand': [['local', 'touch marker']] });
      expect(await hostNetworkGitArgs(['fetch'], '/repo', read, {})).toContain('core.sshCommand=ssh');
      const withEnv = await hostNetworkGitArgs(['fetch'], '/repo', read, { GIT_SSH_COMMAND: 'ssh -v' });
      expect(withEnv.some(a => a.startsWith('core.sshCommand='))).toBe(false);
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
