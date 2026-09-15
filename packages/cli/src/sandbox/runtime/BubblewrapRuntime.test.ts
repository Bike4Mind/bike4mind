import { describe, it, expect } from 'vitest';
import { BubblewrapRuntime } from './BubblewrapRuntime.js';
import os from 'os';

describe('BubblewrapRuntime', () => {
  const runtime = new BubblewrapRuntime();

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
      });

      const bindIdx = result.args.indexOf('/home/test/project');
      expect(bindIdx).toBeGreaterThan(-1);
      // --bind <src> <dest>; look for --bind before the path
      const precedingArgs = result.args.slice(0, bindIdx);
      expect(precedingArgs).toContain('--bind');
    });

    it('mounts denied paths as tmpfs', () => {
      const home = os.homedir();
      const result = runtime.wrapCommand({
        command: 'cat secret',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [`${home}/.ssh`, `${home}/.aws`],
        },
      });

      // Denied paths should appear as --tmpfs
      const sshIdx = result.args.indexOf(`${home}/.ssh`);
      expect(sshIdx).toBeGreaterThan(-1);
      expect(result.args[sshIdx - 1]).toBe('--tmpfs');

      const awsIdx = result.args.indexOf(`${home}/.aws`);
      expect(awsIdx).toBeGreaterThan(-1);
      expect(result.args[awsIdx - 1]).toBe('--tmpfs');
    });

    it('includes namespace isolation flags', () => {
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      expect(result.args).toContain('--unshare-all');
      expect(result.args).toContain('--share-net');
      expect(result.args).toContain('--die-with-parent');
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
        env: { FOO: 'bar' },
      });

      expect(result.commandString).toContain('--setenv');
      expect(result.commandString).toContain('FOO');
      expect(result.commandString).toContain('bar');
    });
  });
});
