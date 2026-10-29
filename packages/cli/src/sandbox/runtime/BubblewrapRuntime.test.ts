import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BubblewrapRuntime } from './BubblewrapRuntime.js';
import os from 'os';
import path from 'path';
import { mkdirSync, statSync } from 'fs';
import { isBinaryAvailable } from './SandboxRuntimeAdapter.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: vi.fn(), statSync: vi.fn(), realpathSync: (p: string) => p };
});

vi.mock('./SandboxRuntimeAdapter.js', async () => {
  const actual = await vi.importActual<typeof import('./SandboxRuntimeAdapter.js')>('./SandboxRuntimeAdapter.js');
  return { ...actual, isBinaryAvailable: vi.fn(() => true) };
});

const fsEntry = (isDir: boolean) => ({ isDirectory: () => isDir }) as ReturnType<typeof statSync>;

describe('BubblewrapRuntime', () => {
  const runtime = new BubblewrapRuntime();

  beforeEach(() => {
    vi.mocked(isBinaryAvailable).mockReset().mockReturnValue(true);
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  describe('metadata', () => {
    it('has correct platform and name', () => {
      expect(runtime.platform).toBe('linux');
      expect(runtime.name).toBe('bubblewrap');
    });

    it.each([true, false])('is available only when bwrap is on PATH (%s)', available => {
      vi.mocked(isBinaryAvailable).mockReturnValue(available);
      expect(runtime.isAvailable()).toBe(available);
      expect(isBinaryAvailable).toHaveBeenCalledWith('bwrap');
    });
  });

  describe('wrapCommand', () => {
    it.each(['.git', '.bike4mind'])('fails closed for a replaceable %s symlink', async metadataEntry => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-symlink-'));
      try {
        const target = path.join(fixture, 'target');
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(fixture, metadataEntry));
        expect(() =>
          runtime.wrapCommand({
            command: 'true',
            cwd: fixture,
            filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
            networkEnabled: false,
          })
        ).toThrow('Cannot protect sandbox metadata symlink');
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it('rejects a metadata cwd before creating a project config directory on the host', async () => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cwd-'));
      try {
        const cwd = path.join(fixture, '.git', 'hooks');
        fs.mkdirSync(cwd, { recursive: true });
        expect(() =>
          runtime.wrapCommand({
            command: 'true',
            cwd,
            filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
            networkEnabled: false,
          })
        ).toThrow('Cannot use protected metadata as sandbox cwd');
        expect(mkdirSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

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
      for (const p of ['.bike4mind']) {
        const full = `/home/test/project/${p}`;
        const idx = result.args.indexOf(full);
        expect(idx).toBeGreaterThan(bindIdx);
        expect(result.args[idx - 1]).toBe('--ro-bind');
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
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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

    it('fails closed when .bike4mind cannot be created', () => {
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error('EROFS');
      });
      expect(() =>
        runtime.wrapCommand({
          command: 'true',
          cwd: '/home/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
        })
      ).toThrow('EROFS');
    });

    it('binds the entire .git read-only even when hooks/config are absent', () => {
      vi.mocked(statSync).mockImplementation(p => {
        if (p === '/home/test/project/.git') return fsEntry(true);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const result = runtime.wrapCommand({
        command: 'mkdir .git/hooks',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      const gitIndex = result.args.indexOf('/home/test/project/.git');
      expect(result.args.slice(gitIndex - 1, gitIndex + 2)).toEqual([
        '--ro-bind',
        '/home/test/project/.git',
        '/home/test/project/.git',
      ]);
      expect(result.args).not.toContain('/home/test/project/.git/hooks');
      expect(result.args).not.toContain('/home/test/project/.git/config');
    });

    it('mounts the home directory before the writable cwd and protected children', () => {
      const cwd = `${os.homedir()}/project`;
      const result = runtime.wrapCommand({
        command: 'touch x',
        cwd,
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });
      expect(result.args.indexOf(os.homedir())).toBeLessThan(result.args.indexOf(cwd));
      expect(result.args.indexOf(cwd)).toBeLessThan(result.args.indexOf(`${cwd}/.bike4mind`));
    });

    it('does not treat an unreadable denied path as missing', () => {
      vi.mocked(statSync).mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      expect(() =>
        runtime.wrapCommand({
          command: 'cat secret',
          cwd: '/home/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: ['/secret'] },
          networkEnabled: false,
        })
      ).toThrow('EACCES');
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
      expect(result.args).not.toContain('/home/test/project/.git/config');
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

    describe('container engine sockets', () => {
      const home = os.homedir();
      const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
      const present: Record<string, boolean> = {
        [`${home}/.colima`]: true,
        [`${home}/.docker`]: true,
        '/var/run/docker.sock': false,
        '/run/user/1000/podman': true,
        '/run/user/1000/docker.sock': false,
      };
      const wrap = (allowContainerSockets?: boolean) =>
        runtime.wrapCommand({
          command: 'true',
          cwd: '/home/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [`${home}/.docker`] },
          networkEnabled: false,
          allowContainerSockets,
        });
      const mountOf = (args: string[], target: string) => {
        const idx = args.lastIndexOf(target);
        return idx === -1 ? null : args.slice(idx - (args[idx - 1] === '--tmpfs' ? 1 : 2), idx + 1);
      };

      beforeEach(() => {
        process.env.XDG_RUNTIME_DIR = '/run/user/1000';
        vi.mocked(statSync).mockImplementation(p => {
          if (String(p) in present) return fsEntry(present[String(p)]);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
      });

      afterEach(() => {
        if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
      });

      it('masks existing socket dirs and files after the home bind', () => {
        const { args } = wrap();
        const homeBindIdx = args.indexOf(home);
        expect(mountOf(args, `${home}/.colima`)).toEqual(['--tmpfs', `${home}/.colima`]);
        expect(args.lastIndexOf(`${home}/.colima`)).toBeGreaterThan(homeBindIdx);
        expect(mountOf(args, '/run/user/1000/podman')).toEqual(['--tmpfs', '/run/user/1000/podman']);
        expect(mountOf(args, '/var/run/docker.sock')).toEqual(['--ro-bind', '/dev/null', '/var/run/docker.sock']);
        expect(mountOf(args, '/run/user/1000/docker.sock')).toEqual([
          '--ro-bind',
          '/dev/null',
          '/run/user/1000/docker.sock',
        ]);
        expect(args).not.toContain(`${home}/.lima`);
      });

      it('does not remount a socket dir already hidden by a denied path', () => {
        const { args } = wrap();
        expect(args.filter(arg => arg === `${home}/.docker`)).toHaveLength(1);
      });

      it.each(['EACCES', 'ELOOP'])('skips a container socket path that fails with %s', code => {
        vi.mocked(statSync).mockImplementation(p => {
          if (String(p) === `${home}/.colima`) throw Object.assign(new Error(code), { code });
          if (String(p) in present) return fsEntry(present[String(p)]);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        const { args } = wrap();
        expect(args).not.toContain(`${home}/.colima`);
        expect(mountOf(args, '/run/user/1000/podman')).toEqual(['--tmpfs', '/run/user/1000/podman']);
      });

      it('still fails closed on other errors', () => {
        vi.mocked(statSync).mockImplementation(p => {
          if (String(p) === `${home}/.colima`) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        expect(() => wrap()).toThrow('EIO');
      });

      it('does not mask a socket dir that contains the working directory', () => {
        const { args } = runtime.wrapCommand({
          command: 'true',
          cwd: `${home}/.colima/work`,
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
        });
        expect(args).not.toContain(`${home}/.colima`);
        expect(mountOf(args, '/run/user/1000/podman')).toEqual(['--tmpfs', '/run/user/1000/podman']);
      });

      it('leaves them alone when allowContainerSockets is set', () => {
        const { args } = wrap(true);
        expect(args).not.toContain(`${home}/.colima`);
        expect(args).not.toContain('/var/run/docker.sock');
        expect(args).not.toContain('/run/user/1000/podman');
      });
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

    describe('with network enabled', () => {
      const networkOptions = {
        command: 'curl https://example.com',
        cwd: '/home/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: true,
        proxyPort: 43123,
        proxySocketPath: '/tmp/b4m-proxy-abc/proxy.sock',
        env: { HTTPS_PROXY: 'http://127.0.0.1:43123' },
      };

      it('keeps a private network namespace instead of sharing the host one', () => {
        const { args } = runtime.wrapCommand(networkOptions);

        expect(args).not.toContain('--share-net');
        expect(args).toContain('--unshare-net');
        expect(args.indexOf('--unshare-net')).toBeGreaterThan(args.indexOf('--unshare-all'));
      });

      it('mounts the proxy socket after the writable cwd bind', () => {
        const { args } = runtime.wrapCommand(networkOptions);
        const socketBind = args.indexOf('/tmp/b4m-proxy-abc/proxy.sock');

        expect(args.slice(socketBind - 1, socketBind + 2)).toEqual([
          '--ro-bind',
          '/tmp/b4m-proxy-abc/proxy.sock',
          '/run/b4m/proxy.sock',
        ]);
        expect(socketBind).toBeGreaterThan(args.indexOf('--bind'));
        expect(isBinaryAvailable).toHaveBeenCalledWith('socat');
      });

      it('starts a loopback relay on the proxy port before running the command', () => {
        const { args, commandString } = runtime.wrapCommand(networkOptions);
        const [bash, flag, script, argv0, command] = args.slice(-5);

        expect([bash, flag, argv0, command]).toEqual(['bash', '-c', 'b4m-sandbox', 'curl https://example.com']);
        expect(script).toContain(
          'socat TCP-LISTEN:43123,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/b4m/proxy.sock'
        );
        expect(script).toContain('/dev/tcp/127.0.0.1/43123');
        expect(script).toContain('-ge 100');
        expect(script.trim().endsWith('exec bash -c "$1"')).toBe(true);
        expect(commandString).toContain('b4m-sandbox');
      });

      it('passes the proxy env vars into the sandbox', () => {
        const { args } = runtime.wrapCommand(networkOptions);
        const setenv = args.indexOf('--setenv');

        expect(args.slice(setenv, setenv + 3)).toEqual(['--setenv', 'HTTPS_PROXY', 'http://127.0.0.1:43123']);
      });

      it('fails closed when socat is not installed', () => {
        vi.mocked(isBinaryAvailable).mockReturnValue(false);
        expect(() => runtime.wrapCommand(networkOptions)).toThrow('Sandbox network on Linux requires socat');
      });

      it.each([
        ['port', { proxyPort: undefined }],
        ['socket', { proxySocketPath: undefined }],
        ['socket', { proxySocketPath: '' }],
      ])('fails closed without a proxy %s', (_missing, overrides) => {
        expect(() => runtime.wrapCommand({ ...networkOptions, ...overrides })).toThrow(
          'Sandbox network on Linux requires a running filtering proxy with a unix socket'
        );
      });

      it.each([0, 65536, 1.5])('rejects invalid proxy port %s before building the relay', proxyPort => {
        expect(() => runtime.wrapCommand({ ...networkOptions, proxyPort })).toThrow('Invalid sandbox proxy port');
      });

      it('ignores proxy settings when network is disabled', () => {
        const { args } = runtime.wrapCommand({ ...networkOptions, networkEnabled: false });

        expect(args).not.toContain('/run/b4m/proxy.sock');
        expect(args.slice(-3)).toEqual(['bash', '-c', 'curl https://example.com']);
        expect(isBinaryAvailable).not.toHaveBeenCalledWith('socat');
      });
    });

    it('binds allowed read paths outside the home directory read-only', () => {
      const { args } = runtime.wrapCommand({
        command: 'ls',
        cwd: '/home/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: ['/opt/toolchain', os.homedir(), path.join(os.homedir(), '.gitconfig')],
          deniedPaths: [],
        },
        networkEnabled: false,
      });
      const binds = args.join(' ');

      expect(binds).toContain('--ro-bind-try /opt/toolchain /opt/toolchain');
      expect(binds).not.toContain(`--ro-bind-try ${os.homedir()}`);
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
