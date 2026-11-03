import { describe, it, expect, vi, afterEach } from 'vitest';
import { SeatbeltRuntime } from './SeatbeltRuntime.js';
import { isBinaryAvailable } from './SandboxRuntimeAdapter.js';
import os from 'os';
import path from 'path';
import { realpathSync, writeFileSync } from 'fs';

// Mock only the specific functions we need
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    realpathSync: vi.fn(actual.realpathSync),
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

    it('is available when sandbox-exec is on PATH', () => {
      expect(runtime.isAvailable()).toBe(isBinaryAvailable('sandbox-exec'));
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
        networkEnabled: false,
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
        networkEnabled: false,
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
        networkEnabled: false,
      });

      expect(profile).toContain(`(allow file-read* (subpath "${home}/.gitconfig"))`);
      expect(profile).toContain(`(allow file-read* (subpath "${home}/.npmrc"))`);
    });

    it('denies writes to protected workspace paths after the cwd allow', () => {
      const profile = runtime.generateProfile({
        command: 'touch x',
        cwd: '/Users/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });

      const allowIdx = profile.indexOf('(allow file-write* (subpath "/Users/test/project"))');
      expect(allowIdx).toBeGreaterThan(-1);
      for (const p of ['.git', '.bike4mind']) {
        const denyIdx = profile.indexOf(`(deny file-write* (subpath "/Users/test/project/${p}"))`);
        expect(denyIdx).toBeGreaterThan(allowIdx);
      }
    });

    it('applies credential denies after overlapping read allowances', () => {
      const home = os.homedir();
      const profile = runtime.generateProfile({
        command: 'cat ~/.npmrc',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: ['$HOME', '~/.npmrc'],
          deniedPaths: ['$HOME/.npmrc'],
        },
        networkEnabled: false,
      });
      const denyIndex = profile.indexOf(`(deny file-read* file-write* (subpath "${home}/.npmrc"))`);
      expect(denyIndex).toBeGreaterThan(profile.indexOf(`(allow file-read* (subpath "${home}"))`));
      expect(denyIndex).toBeGreaterThan(profile.indexOf(`(allow file-read* (subpath "${home}/.npmrc"))`));
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
        networkEnabled: false,
      });

      expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    });

    it('allows writes to standard device files after the global write deny', () => {
      const profile = runtime.generateProfile({
        command: 'git status > /dev/null',
        cwd: '/Users/test/project',
        filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
        networkEnabled: false,
      });

      const deny = profile.indexOf('(deny file-write*)');
      for (const allow of [
        '(allow file-write-data (literal "/dev/null"))',
        '(allow file-write-data (literal "/dev/zero"))',
        '(allow file-write-data (literal "/dev/dtracehelper"))',
        '(allow file-write-data (subpath "/dev/fd"))',
      ]) {
        expect(profile.indexOf(allow)).toBeGreaterThan(deny);
      }
      expect(profile).not.toContain('(subpath "/dev")');
      expect(profile).not.toContain('/dev/tty');
    });

    it('allows writes to the resolved temp dir when os.tmpdir() is a symlink', () => {
      const link = '/var/folders/xx/T';
      const real = '/private/var/folders/xx/T';
      const tmpdir = vi.spyOn(os, 'tmpdir').mockReturnValue(link);
      const actualRealpath = vi.mocked(realpathSync).getMockImplementation()!;
      vi.mocked(realpathSync).mockImplementation(((p: string) =>
        p === link ? real : actualRealpath(p)) as typeof realpathSync);
      try {
        const profile = runtime.generateProfile({
          command: 'mktemp',
          cwd: '/Users/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
        });
        expect(profile).toContain(`(allow file-write* (subpath "${link}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${real}"))`);
      } finally {
        tmpdir.mockRestore();
        vi.mocked(realpathSync).mockImplementation(actualRealpath);
      }
    });

    it('allows writes to the resolved working directory when cwd is a symlink', () => {
      const link = '/Users/test/link';
      const real = '/Users/test/real';
      const actualRealpath = vi.mocked(realpathSync).getMockImplementation()!;
      vi.mocked(realpathSync).mockImplementation(((p: string) =>
        p === link ? real : actualRealpath(p)) as typeof realpathSync);
      try {
        const profile = runtime.generateProfile({
          command: 'touch x',
          cwd: link,
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
        });
        expect(profile).toContain(`(allow file-write* (subpath "${link}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${real}"))`);
      } finally {
        vi.mocked(realpathSync).mockImplementation(actualRealpath);
      }
    });

    it('denies network when network is disabled (fail-closed)', () => {
      const profile = runtime.generateProfile({
        command: 'curl https://example.com',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      expect(profile).toContain('(deny network*)');
    });

    it('re-allows local unix sockets after denying IP, in that order (fail-closed local IPC)', () => {
      // Regression: a bare `(deny network*)` also severs AF_UNIX (ssh-agent,
      // gpg-agent, docker.sock). Seatbelt is last-match-wins, so the unix-socket
      // re-allows MUST come after the deny, and the deny after `(allow default)`.
      const profile = runtime.generateProfile({
        command: 'ssh-add -l',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
      });

      const allowDefaultIdx = profile.indexOf('(allow default)');
      const denyIdx = profile.indexOf('(deny network*)');
      const unixOutboundIdx = profile.indexOf('(allow network-outbound (remote unix-socket))');

      expect(allowDefaultIdx).toBeGreaterThan(-1);
      expect(denyIdx).toBeGreaterThan(allowDefaultIdx);
      expect(unixOutboundIdx).toBeGreaterThan(denyIdx);
      expect(profile).toContain('(allow network-inbound (local unix-socket))');
      expect(profile).toContain('(allow network-bind (local unix-socket))');
    });

    it('denies all IP network when network is enabled without a proxy port', () => {
      const profile = runtime.generateProfile({
        command: 'curl https://example.com',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: true,
      });

      expect(profile).toContain('(deny network*)');
      expect(profile).toContain('(allow network-outbound (remote unix-socket))');
      expect(profile).not.toContain('(local ip');
      expect(profile).not.toContain('(remote ip');
    });

    describe('with a filtering proxy', () => {
      const proxiedProfile = (proxyPort: number) =>
        runtime.generateProfile({
          command: 'curl https://example.com',
          cwd: '/Users/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: true,
          proxyPort,
        });

      it('denies network and re-allows outbound loopback only to the proxy port', () => {
        const profile = proxiedProfile(43123);
        const denyIdx = profile.indexOf('(deny network*)');
        const loopbackRules = [
          '(allow network-bind (local ip "localhost:*"))',
          '(allow network-inbound (local ip "localhost:*"))',
          '(allow network-outbound (remote ip "localhost:43123"))',
        ];

        expect(denyIdx).toBeGreaterThan(profile.indexOf('(allow default)'));
        for (const rule of loopbackRules) expect(profile.indexOf(rule)).toBeGreaterThan(denyIdx);
        expect(profile.match(/ ip "/g)).toHaveLength(loopbackRules.length);
        expect(profile).not.toContain('(remote ip "localhost:*")');
        expect(profile.match(/network-outbound \(remote ip/g)).toHaveLength(1);
      });

      it('keeps local unix sockets but blocks the DNS resolver socket', () => {
        const profile = proxiedProfile(43123);
        const unixAllowIdx = profile.indexOf('(allow network-outbound (remote unix-socket))');
        const resolverDenyIdx = profile.indexOf(
          '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
        );

        expect(unixAllowIdx).toBeGreaterThan(profile.indexOf('(deny network*)'));
        expect(resolverDenyIdx).toBeGreaterThan(unixAllowIdx);
        expect(profile).toContain('(allow network-inbound (local unix-socket))');
        expect(profile).toContain('(allow network-bind (local unix-socket))');
      });

      it.each([0, -1, 65536, 1.5, Number.NaN])('rejects invalid proxy port %s', port => {
        expect(() => proxiedProfile(port)).toThrow('Invalid sandbox proxy port');
      });

      it('ignores the proxy port when network is disabled', () => {
        const profile = runtime.generateProfile({
          command: 'curl https://example.com',
          cwd: '/Users/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
          proxyPort: 43123,
        });

        expect(profile).toContain('(deny network*)');
        expect(profile).not.toContain('remote ip');
        expect(profile).toContain(
          '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
        );
      });
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
        networkEnabled: false,
      });

      expect(profile).toContain(`(deny file-read* file-write* (subpath "${home}/.ssh"))`);
      expect(profile).not.toContain('$HOME');
    });
  });

  describe('container engine sockets', () => {
    const baseOptions = {
      command: 'true',
      cwd: '/Users/test/project',
      filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
    };
    const home = realpathSync(os.homedir());

    it.each([false, true])('denies them after the unix-socket allow (network %s)', networkEnabled => {
      const profile = runtime.generateProfile({ ...baseOptions, networkEnabled, proxyPort: 8080 });
      const unixAllowIdx = profile.indexOf('(allow network-outbound (remote unix-socket))');
      const dockerSocket = path.join(realpathSync('/var/run'), 'docker.sock');
      const dockerDeny = `(deny network-outbound (remote unix-socket (path-literal "${dockerSocket}")))`;
      expect(unixAllowIdx).toBeGreaterThan(-1);
      expect(profile.indexOf(dockerDeny)).toBeGreaterThan(unixAllowIdx);
      for (const dir of [
        '.docker',
        'Library/Containers/com.docker.docker/Data',
        '.colima',
        '.lima',
        '.rd',
        '.orbstack',
        '.local/share/containers',
      ]) {
        const rule = `(deny network-outbound (remote unix-socket (subpath "${home}/${dir}")))`;
        expect(profile.indexOf(rule)).toBeGreaterThan(unixAllowIdx);
      }
    });

    it('denies the docker.sock symlink at its resolved target', async () => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-xdg-')));
      const original = process.env.XDG_RUNTIME_DIR;
      try {
        fs.mkdirSync(path.join(fixture, 'engine'));
        fs.writeFileSync(path.join(fixture, 'engine', 'api.sock'), '');
        fs.symlinkSync(path.join(fixture, 'engine', 'api.sock'), path.join(fixture, 'docker.sock'));
        process.env.XDG_RUNTIME_DIR = fixture;
        const profile = runtime.generateProfile({ ...baseOptions, networkEnabled: false });
        expect(profile).toContain(
          `(deny network-outbound (remote unix-socket (path-literal "${fixture}/docker.sock")))`
        );
        expect(profile).toContain(
          `(deny network-outbound (remote unix-socket (path-literal "${fixture}/engine/api.sock")))`
        );
        expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${fixture}/podman")))`);
      } finally {
        if (original === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = original;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it('denies renaming a configured socket or its parents after the write allows', async () => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-host-')));
      const original = process.env.DOCKER_HOST;
      try {
        process.env.DOCKER_HOST = `unix://${fixture}/engine/api.sock`;
        const profile = runtime.generateProfile({ ...baseOptions, networkEnabled: false });
        const lastWriteAllowIdx = profile.lastIndexOf('(allow file-write*');
        expect(lastWriteAllowIdx).toBeGreaterThan(-1);
        for (const rule of [
          `(deny file-write* (path-literal "${fixture}/engine/api.sock"))`,
          `(deny file-write* (path-literal "${fixture}/engine"))`,
          `(deny file-write* (path-literal "${fixture}"))`,
          `(deny file-write* (subpath "${home}/.colima"))`,
        ]) {
          expect(profile.indexOf(rule)).toBeGreaterThan(lastWriteAllowIdx);
        }
      } finally {
        if (original === undefined) delete process.env.DOCKER_HOST;
        else process.env.DOCKER_HOST = original;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });

    it.each(['EACCES', 'ELOOP', 'EPERM'])('still denies a container path that fails to resolve with %s', async code => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const blocked = '/seatbelt-unresolvable/colima';
      const original = process.env.COLIMA_HOME;
      vi.mocked(realpathSync).mockImplementation(((p: string) => {
        if (p.startsWith('/seatbelt-unresolvable')) throw Object.assign(new Error(code), { code });
        return fs.realpathSync(p);
      }) as typeof realpathSync);
      try {
        process.env.COLIMA_HOME = blocked;
        const profile = runtime.generateProfile({ ...baseOptions, networkEnabled: false });
        expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${blocked}")))`);
      } finally {
        vi.mocked(realpathSync).mockImplementation(fs.realpathSync as typeof realpathSync);
        if (original === undefined) delete process.env.COLIMA_HOME;
        else process.env.COLIMA_HOME = original;
      }
    });

    it('rethrows other resolution errors', async () => {
      const fs = await vi.importActual<typeof import('fs')>('fs');
      const original = process.env.COLIMA_HOME;
      vi.mocked(realpathSync).mockImplementation(((p: string) => {
        if (p.startsWith('/seatbelt-unresolvable')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return fs.realpathSync(p);
      }) as typeof realpathSync);
      try {
        process.env.COLIMA_HOME = '/seatbelt-unresolvable/colima';
        expect(() => runtime.generateProfile({ ...baseOptions, networkEnabled: false })).toThrow('EIO');
      } finally {
        vi.mocked(realpathSync).mockImplementation(fs.realpathSync as typeof realpathSync);
        if (original === undefined) delete process.env.COLIMA_HOME;
        else process.env.COLIMA_HOME = original;
      }
    });

    it('leaves them reachable when allowContainerSockets is set', () => {
      const profile = runtime.generateProfile({ ...baseOptions, networkEnabled: false, allowContainerSockets: true });
      expect(profile).toContain('(allow network-outbound (remote unix-socket))');
      expect(profile).not.toContain('docker.sock');
      expect(profile).not.toContain('.colima');
      expect(profile).not.toMatch(/\(deny file-write\* \(path-literal/);
    });
  });

  describe('wrapCommand', () => {
    it.each([
      [new Error('disk full'), 'Failed to create sandbox profile: disk full'],
      ['disk full', 'Failed to create sandbox profile: disk full'],
    ])('wraps profile write failures (%s)', (thrown, message) => {
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw thrown;
      });
      expect(() =>
        runtime.wrapCommand({
          command: 'ls',
          cwd: '/Users/test/project',
          filesystemConfig: { writeOnlyToWorkingDir: true, allowedReadPaths: [], deniedPaths: [] },
          networkEnabled: false,
        })
      ).toThrow(message);
    });

    it('returns a WrappedCommand with sandbox-exec', () => {
      const result = runtime.wrapCommand({
        command: 'echo hello',
        cwd: '/Users/test/project',
        filesystemConfig: {
          writeOnlyToWorkingDir: true,
          allowedReadPaths: [],
          deniedPaths: [],
        },
        networkEnabled: false,
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
        networkEnabled: false,
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
        networkEnabled: false,
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
        networkEnabled: false,
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
        networkEnabled: false,
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
        networkEnabled: false,
        env,
      });

      expect(result.env).toEqual(env);
    });
  });
});
