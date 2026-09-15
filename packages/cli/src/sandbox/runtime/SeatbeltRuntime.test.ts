import { describe, it, expect, vi, afterEach } from 'vitest';
import { SeatbeltRuntime } from './SeatbeltRuntime.js';
import os from 'os';
import { writeFileSync } from 'fs';

// Mock only the specific functions we need
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/b4m-sandbox-test'),
  };
});

describe('SeatbeltRuntime', () => {
  const runtime = new SeatbeltRuntime();

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('metadata', () => {
    it('has correct platform and name', () => {
      expect(runtime.platform).toBe('darwin');
      expect(runtime.name).toBe('seatbelt');
    });
  });

  describe('generateProfile', () => {
    it('generates a profile that restricts writes to CWD', () => {
      const profile = runtime.generateProfile({
        command: 'ls -la',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(allow default)');
      expect(profile).toContain('(deny file-write*)');
      expect(profile).toContain('(allow file-write* (subpath "/Users/test/project"))');
    });

    it('includes denied paths', () => {
      const home = os.homedir();
      const profile = runtime.generateProfile({
        command: 'ls',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [`${home}/.ssh`, `${home}/.aws`],
        },
      });

      expect(profile).toContain(`(deny file-read* file-write* (subpath "${home}/.ssh"))`);
      expect(profile).toContain(`(deny file-read* file-write* (subpath "${home}/.aws"))`);
    });

    it('includes allowed read paths', () => {
      const home = os.homedir();
      const profile = runtime.generateProfile({
        command: 'ls',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: false,
          allowedReadPaths: [`${home}/.gitconfig`, `${home}/.npmrc`],
          deniedPaths: [],
        },
      });

      expect(profile).toContain(`(allow file-read* (subpath "${home}/.gitconfig"))`);
      expect(profile).toContain(`(allow file-read* (subpath "${home}/.npmrc"))`);
    });

    it('allows writes to temp directories', () => {
      const profile = runtime.generateProfile({
        command: 'npm install',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    });

    it('expands $HOME and $USER in paths', () => {
      const home = os.homedir();
      const profile = runtime.generateProfile({
        command: 'ls',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: ['$HOME/.ssh'],
        },
      });

      expect(profile).toContain(`(deny file-read* file-write* (subpath "${home}/.ssh"))`);
      expect(profile).not.toContain('$HOME');
    });
  });

  describe('wrapCommand', () => {
    it('returns a WrappedCommand with sandbox-exec', () => {
      const result = runtime.wrapCommand({
        command: 'echo hello',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      expect(result.executable).toBe('sandbox-exec');
      expect(result.args[0]).toBe('-f');
      expect(result.args[1]).toBe('/tmp/b4m-sandbox-test/sandbox.sb');
      expect(result.args[2]).toBe('bash');
      expect(result.args[3]).toBe('-c');
      expect(result.args[4]).toBe('echo hello');
      expect(result.cleanupPaths).toContain('/tmp/b4m-sandbox-test/sandbox.sb');
    });

    it('writes profile to temp file', () => {
      runtime.wrapCommand({
        command: 'ls',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      // Verify the mocked writeFileSync was called
      expect(writeFileSync).toHaveBeenCalledWith(
        '/tmp/b4m-sandbox-test/sandbox.sb',
        expect.stringContaining('(version 1)'),
        'utf-8'
      );
    });

    it('commandString contains the sandbox-exec invocation', () => {
      const result = runtime.wrapCommand({
        command: 'git status',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
      });

      expect(result.commandString).toContain('sandbox-exec');
      expect(result.commandString).toContain('git status');
    });

    it('includes env vars as prefix in commandString', () => {
      const result = runtime.wrapCommand({
        command: 'curl https://example.com',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        env: { HTTP_PROXY: 'http://127.0.0.1:8080', HTTPS_PROXY: 'http://127.0.0.1:8080' },
      });

      expect(result.commandString).toMatch(/^HTTP_PROXY=.*HTTPS_PROXY=.*sandbox-exec/);
    });

    it('commandString has no env prefix when env is empty', () => {
      const result = runtime.wrapCommand({
        command: 'ls',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        env: {},
      });

      expect(result.commandString).toMatch(/^sandbox-exec/);
    });

    it('stores env object on WrappedCommand', () => {
      const env = { FOO: 'bar', BAZ: 'qux' };
      const result = runtime.wrapCommand({
        command: 'echo test',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        env,
      });

      expect(result.env).toEqual(env);
    });
  });
});
