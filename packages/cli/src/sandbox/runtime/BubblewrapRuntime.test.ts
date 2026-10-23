import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BubblewrapRuntime } from './BubblewrapRuntime.js';
import os from 'os';
import { mkdirSync, statSync } from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: vi.fn(), statSync: vi.fn() };
});

const fsEntry = (isDir: boolean) => ({ isDirectory: () => isDir }) as ReturnType<typeof statSync>;

describe('BubblewrapRuntime', () => {
  const runtime = new BubblewrapRuntime();

  beforeEach(() => {
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('metadata', () => {
    it('has correct platform and name', () => {
      expect(runtime.platform).toBe('linux');
      expect(runtime.name).toBe('bubblewrap');
    });
  });

  describe('wrapCommand', () => {
    it('includes read-only system binds', () => {
      const result = runtime.wrapCommand({
        command: 'ls -la',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(result.executable).toBe('bwrap');
      expect(result.args).toContain('--ro-bind-try');

      // Check that /usr is bound read-only: --ro-bind-try /usr /usr
      const firstUsrIdx = result.args.indexOf('/usr');
      expect(firstUsrIdx).toBeGreaterThan(-1);
      expect(result.args[firstUsrIdx - 1]).toBe('--ro-bind-try');
      expect(result.args[firstUsrIdx + 1]).toBe('/usr');
    });

    it('binds CWD as read-write', () => {
      const result = runtime.wrapCommand({
        command: 'npm install',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      const bindIdx = result.args.indexOf('/home/test/project');
      expect(bindIdx).toBeGreaterThan(-1);
      // --bind <src> <dest>; look for --bind before the path
      const precedingArgs = result.args.slice(0, bindIdx);
      expect(precedingArgs).toContain('--bind');
    });

    it('re-binds protected workspace paths read-only after the cwd bind', () => {
      const result = runtime.wrapCommand({
        command: 'touch x',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });

      const bindIdx = result.args.findIndex((a, i) => a === '--bind' && result.args[i + 1] === '/home/test/project');
      expect(bindIdx).toBeGreaterThan(-1);
      for (const p of ['.git/config', '.git/config.worktree', '.git/commondir', '.git/hooks', '.bike4mind']) {
        const full = `/home/test/project/${p}`;
        const idx = result.args.indexOf(full);
        expect(idx).toBeGreaterThan(bindIdx);
        expect(result.args[idx - 1]).toBe(p === '.bike4mind' ? '--ro-bind' : '--ro-bind-try');
        expect(result.args[idx + 1]).toBe(full);
      }
    });

    it('creates the .bike4mind dir and binds it with --ro-bind', () => {
      const result = runtime.wrapCommand({
        command: 'true',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      const dir = '/home/test/project/.bike4mind';
      expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
      const idx = result.args.indexOf(dir);
      expect(result.args[idx - 1]).toBe('--ro-bind');
    });

    it('hides denied files with /dev/null and skips missing denied paths', () => {
      const home = os.homedir();
      vi.mocked(statSync).mockImplementation(p => {
        if (p === `${home}/.netrc`) return fsEntry(false);
        throw new Error('ENOENT');
      });
      const result = runtime.wrapCommand({
        command: 'true',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [`${home}/.netrc`, `${home}/.missing`],
        },
        networkEnabled: false,
      });
      const idx = result.args.indexOf(`${home}/.netrc`);
      expect(result.args.slice(idx - 2, idx + 1)).toEqual(['--ro-bind', '/dev/null', `${home}/.netrc`]);
      expect(result.args).not.toContain(`${home}/.missing`);
    });

    it('skips the .bike4mind bind when the dir cannot be created', () => {
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error('EROFS');
      });
      const result = runtime.wrapCommand({
        command: 'true',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      expect(result.args).not.toContain('/home/test/project/.bike4mind');
    });

    it('binds a .git directory as a mountpoint before the inner ro-binds', () => {
      vi.mocked(statSync).mockImplementation(() => fsEntry(true));
      const result = runtime.wrapCommand({
        command: 'true',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      const git = '/home/test/project/.git';
      const gitIdx = result.args.indexOf(git);
      expect(result.args[gitIdx - 1]).toBe('--bind');
      for (const p of ['config', 'config.worktree', 'commondir', 'hooks']) {
        const idx = result.args.indexOf(`${git}/${p}`);
        expect(result.args[idx - 1]).toBe('--ro-bind-try');
        expect(idx).toBeGreaterThan(gitIdx);
      }
    });

    it('binds a worktree .git file read-only', () => {
      vi.mocked(statSync).mockImplementation(() => fsEntry(false));
      const result = runtime.wrapCommand({
        command: 'true',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      const gitIdx = result.args.indexOf('/home/test/project/.git');
      expect(result.args[gitIdx - 1]).toBe('--ro-bind');
    });

    it('mounts denied paths as tmpfs', () => {
      const home = os.homedir();
      vi.mocked(statSync).mockImplementation(() => fsEntry(true));
      const result = runtime.wrapCommand({
        command: 'cat secret',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [`${home}/.ssh`, `${home}/.aws`],
        },
        networkEnabled: false,
      });

      // Denied paths should appear as --tmpfs
      const sshIdx = result.args.indexOf(`${home}/.ssh`);
      expect(sshIdx).toBeGreaterThan(-1);
      expect(result.args[sshIdx - 1]).toBe('--tmpfs');

      const awsIdx = result.args.indexOf(`${home}/.aws`);
      expect(awsIdx).toBeGreaterThan(-1);
      expect(result.args[awsIdx - 1]).toBe('--tmpfs');
    });

    it('includes namespace isolation flags and denies net when network is disabled', () => {
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(result.args).toContain('--unshare-all');
      expect(result.args).toContain('--unshare-net');
      expect(result.args).not.toContain('--share-net');
      expect(result.args).toContain('--die-with-parent');
      // Order matters: the net flag must follow --unshare-all, else --unshare-all
      // would re-isolate the net namespace a later --share-net meant to keep.
      expect(result.args.indexOf('--unshare-net')).toBeGreaterThan(result.args.indexOf('--unshare-all'));
    });

    it('shares the net namespace when network is enabled', () => {
      const result = runtime.wrapCommand({
        command: 'curl https://example.com',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: true,
      });

      expect(result.args).toContain('--share-net');
      expect(result.args).not.toContain('--unshare-net');
      // --share-net must follow --unshare-all to re-grant the net namespace.
      expect(result.args.indexOf('--share-net')).toBeGreaterThan(result.args.indexOf('--unshare-all'));
    });

    it('sets the working directory', () => {
      const result = runtime.wrapCommand({
        command: 'pwd',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      const chdirIdx = result.args.indexOf('--chdir');
      expect(chdirIdx).toBeGreaterThan(-1);
      expect(result.args[chdirIdx + 1]).toBe('/home/test/project');
    });

    it('ends with the command to execute', () => {
      const result = runtime.wrapCommand({
        command: 'git status',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      const lastThree = result.args.slice(-3);
      expect(lastThree).toEqual(['bash', '-c', 'git status']);
    });

    it('builds a commandString with bwrap', () => {
      const result = runtime.wrapCommand({
        command: 'echo hello',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(result.commandString).toMatch(/^bwrap /);
      expect(result.commandString).toContain('echo hello');
    });

    it('does not include cleanupPaths (no temp files)', () => {
      const result = runtime.wrapCommand({
        command: 'ls',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(result.cleanupPaths).toBeUndefined();
    });

    it('includes --seccomp flag when seccompProfile is provided', () => {
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
        seccompProfile: '/etc/seccomp/default.json',
      });

      const seccompIdx = result.args.indexOf('--seccomp');
      expect(seccompIdx).toBeGreaterThan(-1);
      expect(result.args[seccompIdx + 1]).toBe('/etc/seccomp/default.json');
    });

    it('does not include --seccomp flag when seccompProfile is undefined', () => {
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(result.args).not.toContain('--seccomp');
    });

    it('includes --setenv flags for env vars', () => {
      const result = runtime.wrapCommand({
        command: 'curl https://example.com',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
        env: { HTTP_PROXY: 'http://127.0.0.1:8080', HTTPS_PROXY: 'http://127.0.0.1:8080' },
      });

      const setenvIdx = result.args.indexOf('--setenv');
      expect(setenvIdx).toBeGreaterThan(-1);
      expect(result.args[setenvIdx + 1]).toBe('HTTP_PROXY');
      expect(result.args[setenvIdx + 2]).toBe('http://127.0.0.1:8080');
    });

    it('does not include --setenv when env is empty', () => {
      const result = runtime.wrapCommand({
        command: 'ls',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
        env: {},
      });

      expect(result.args).not.toContain('--setenv');
    });

    it('includes --setenv in commandString', () => {
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
        env: { FOO: 'bar' },
      });

      expect(result.commandString).toContain('--setenv');
      expect(result.commandString).toContain('FOO');
      expect(result.commandString).toContain('bar');
    });
  });
});
