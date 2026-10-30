import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertProxyPort,
  createSandboxRuntime,
  detectPlatform,
  expandPath,
  getContainerSocketPaths,
  getProtectedWorkspacePaths,
  isBinaryAvailable,
  resolveSandboxPath,
} from './SandboxRuntimeAdapter.js';
import os from 'os';
import path from 'path';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

describe('SandboxRuntimeAdapter', () => {
  const fixtureDirectories: string[] = [];
  afterEach(() => {
    for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('protects an enclosing project config directory even outside a repository', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-config-'));
    fixtureDirectories.push(fixture);
    const configDirectory = path.join(fixture, '.bike4mind');
    const cwd = path.join(configDirectory, 'nested');
    mkdirSync(cwd, { recursive: true });
    expect(getProtectedWorkspacePaths(cwd)).toContain(configDirectory);
  });

  it.each(['src/nested', '.git/hooks', '.bike4mind'])(
    'protects parent repository metadata and project config for cwd %s',
    nestedPath => {
      const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-nested-'));
      fixtureDirectories.push(fixture);
      const cwd = path.join(fixture, nestedPath);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(path.join(fixture, '.git'), { recursive: true });
      expect(getProtectedWorkspacePaths(cwd)).toEqual(
        expect.arrayContaining([
          path.join(fixture, '.git'),
          path.join(fixture, '.bike4mind'),
          path.join(cwd, '.git'),
          path.join(cwd, '.bike4mind'),
        ])
      );
    }
  );

  it.each(['absolute', 'relative'])('protects %s worktree metadata and its common directory outside cwd', pathKind => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-worktree-'));
    fixtureDirectories.push(fixture);
    const cwd = path.join(fixture, 'checkout');
    const metadata = path.join(fixture, 'main', '.git', 'worktrees', 'checkout');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(metadata, { recursive: true });
    writeFileSync(
      path.join(cwd, '.git'),
      `gitdir: ${pathKind === 'absolute' ? metadata : path.relative(cwd, metadata)}\n`
    );
    writeFileSync(path.join(metadata, 'commondir'), '../..\n');
    expect(getProtectedWorkspacePaths(cwd)).toEqual(
      expect.arrayContaining([path.join(cwd, '.git'), metadata, path.resolve(metadata, '../..')])
    );
  });

  it('protects worktree metadata that has no common directory file', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-worktree-'));
    fixtureDirectories.push(fixture);
    const cwd = path.join(fixture, 'checkout');
    const metadata = path.join(fixture, 'metadata');
    mkdirSync(cwd);
    mkdirSync(metadata);
    writeFileSync(path.join(cwd, '.git'), `gitdir: ${metadata}\n`);
    expect(getProtectedWorkspacePaths(cwd)).toEqual(expect.arrayContaining([path.join(cwd, '.git'), metadata]));
  });

  it('keeps a fully unresolvable path as-is once it reaches the root', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(realpathSync).mockImplementation((() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as unknown as typeof realpathSync);
    try {
      expect(resolveSandboxPath('/unresolvable/child')).toBe('/unresolvable/child');
    } finally {
      vi.mocked(realpathSync).mockImplementation(fs.realpathSync as typeof realpathSync);
    }
  });

  it('resolves absent sensitive paths through the nearest symlinked ancestor', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-path-'));
    fixtureDirectories.push(fixture);
    const target = path.join(fixture, 'target');
    const alias = path.join(fixture, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias);
    expect(resolveSandboxPath(path.join(alias, 'missing', 'config'))).toBe(
      path.join(resolveSandboxPath(target), 'missing', 'config')
    );
  });

  it('protects a metadata symlink entry and its resolved target', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-metadata-'));
    fixtureDirectories.push(fixture);
    const target = path.join(fixture, 'metadata');
    const cwd = path.join(fixture, 'checkout');
    mkdirSync(target);
    mkdirSync(cwd);
    symlinkSync(target, path.join(cwd, '.git'));
    expect(getProtectedWorkspacePaths(cwd)).toEqual(
      expect.arrayContaining([path.join(cwd, '.git'), resolveSandboxPath(target)])
    );
  });

  describe('getContainerSocketPaths', () => {
    const vars = ['XDG_RUNTIME_DIR', 'DOCKER_HOST', 'CONTAINER_HOST', 'COLIMA_HOME', 'LIMA_HOME', 'XDG_CONFIG_HOME'];
    const saved = Object.fromEntries(vars.map(name => [name, process.env[name]]));
    const withEnv = (values: Record<string, string>) => {
      for (const name of vars) delete process.env[name];
      Object.assign(process.env, values);
      return getContainerSocketPaths();
    };
    afterEach(() => {
      for (const name of vars) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it('covers the Docker Desktop config and data directories', () => {
      const home = os.homedir();
      expect(withEnv({})).toEqual(
        expect.arrayContaining([
          { path: path.join(home, '.docker'), directory: true },
          { path: path.join(home, 'Library/Containers/com.docker.docker/Data'), directory: true },
        ])
      );
    });

    it('adds unix sockets from DOCKER_HOST and CONTAINER_HOST', () => {
      expect(withEnv({ DOCKER_HOST: 'unix:///srv/docker.sock', CONTAINER_HOST: 'unix:///srv/podman.sock' })).toEqual(
        expect.arrayContaining([
          { path: '/srv/docker.sock', directory: false },
          { path: '/srv/podman.sock', directory: false },
        ])
      );
    });

    it('ignores non-unix and relative host values', () => {
      const paths = withEnv({ DOCKER_HOST: 'tcp://127.0.0.1:2375', CONTAINER_HOST: 'unix://relative.sock' }).map(
        entry => entry.path
      );
      expect(paths.some(p => p.includes('2375') || p.endsWith('relative.sock'))).toBe(false);
    });

    it.each([
      ['COLIMA_HOME', '/srv/colima'],
      ['LIMA_HOME', '/srv/lima'],
    ])('adds %s as a directory', (name, value) => {
      expect(withEnv({ [name]: value })).toContainEqual({ path: value, directory: true });
    });

    it('adds the colima config directory under XDG_CONFIG_HOME, defaulting to ~/.config', () => {
      expect(withEnv({ XDG_CONFIG_HOME: '/srv/config' })).toContainEqual({
        path: '/srv/config/colima',
        directory: true,
      });
      expect(withEnv({})).toContainEqual({ path: path.join(os.homedir(), '.config', 'colima'), directory: true });
    });

    it('ignores relative directory variables', () => {
      const paths = withEnv({ XDG_RUNTIME_DIR: 'run', COLIMA_HOME: 'colima', LIMA_HOME: 'lima' }).map(e => e.path);
      expect(paths).not.toContain('colima');
      expect(paths).not.toContain('lima');
      expect(paths.some(p => p.startsWith('run'))).toBe(false);
    });
  });

  describe('detectPlatform', () => {
    it('returns darwin on macOS', () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      expect(detectPlatform()).toBe('darwin');
      vi.restoreAllMocks();
    });

    it('returns linux on Linux', () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      expect(detectPlatform()).toBe('linux');
      vi.restoreAllMocks();
    });

    it('returns null on Windows', () => {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      expect(detectPlatform()).toBeNull();
      vi.restoreAllMocks();
    });

    it('returns null on unsupported platforms', () => {
      vi.spyOn(os, 'platform').mockReturnValue('freebsd');
      expect(detectPlatform()).toBeNull();
      vi.restoreAllMocks();
    });
  });

  describe('expandPath', () => {
    it('expands $HOME', () => {
      const home = os.homedir();
      expect(expandPath('$HOME/.ssh')).toBe(`${home}/.ssh`);
    });

    it('expands $USER', () => {
      const user = os.userInfo().username;
      expect(expandPath('/home/$USER/project')).toBe(`/home/${user}/project`);
    });

    it('expands ~ at start of path', () => {
      const home = os.homedir();
      expect(expandPath('~/.gitconfig')).toBe(`${home}/.gitconfig`);
    });

    it('expands multiple variables in one path', () => {
      const home = os.homedir();
      const user = os.userInfo().username;
      expect(expandPath('$HOME/users/$USER/data')).toBe(`${home}/users/${user}/data`);
    });

    it('returns path unchanged if no variables', () => {
      expect(expandPath('/etc/shadow')).toBe('/etc/shadow');
    });
  });

  describe('isBinaryAvailable', () => {
    it('returns true for a common binary (bash)', () => {
      expect(isBinaryAvailable('bash')).toBe(true);
    });

    it('returns false when PATH is unset', () => {
      const originalPath = process.env.PATH;
      delete process.env.PATH;
      try {
        expect(isBinaryAvailable('bash')).toBe(false);
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('returns false for a nonexistent binary', () => {
      expect(isBinaryAvailable('nonexistent-binary-that-should-not-exist-12345')).toBe(false);
    });
  });
  describe('protected path lookup errors', () => {
    const isRoot = process.getuid?.() === 0;

    it.skipIf(isRoot)('rethrows a .git lookup failure other than a missing entry', () => {
      const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-locked-'));
      fixtureDirectories.push(fixture);
      const cwd = path.join(fixture, 'locked');
      mkdirSync(cwd);
      chmodSync(cwd, 0o000);
      try {
        expect(() => getProtectedWorkspacePaths(cwd)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      } finally {
        chmodSync(cwd, 0o700);
      }
    });

    it.skipIf(isRoot)('rethrows an unreadable .git file', () => {
      const fixture = mkdtempSync(path.join(os.tmpdir(), 'sandbox-gitfile-'));
      fixtureDirectories.push(fixture);
      writeFileSync(path.join(fixture, '.git'), 'gitdir: elsewhere\n', { mode: 0o000 });
      expect(() => getProtectedWorkspacePaths(fixture)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    });
  });

  describe('assertProxyPort', () => {
    it.each([1, 8080, 65535])('accepts port %s', port => {
      expect(() => assertProxyPort(port)).not.toThrow();
    });

    it.each([0, -1, 65536, 1.5, Number.NaN])('rejects port %s', port => {
      expect(() => assertProxyPort(port)).toThrow(`Invalid sandbox proxy port: ${port}`);
    });
  });

  describe('createSandboxRuntime', () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
      vi.restoreAllMocks();
    });

    const withBinary = (binary: string | null) => {
      const binDir = mkdtempSync(path.join(os.tmpdir(), 'sandbox-bin-'));
      fixtureDirectories.push(binDir);
      if (binary) writeFileSync(path.join(binDir, binary), '', { mode: 0o755 });
      process.env.PATH = binDir;
    };

    it('returns null on an unsupported platform', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('win32');
      expect(await createSandboxRuntime()).toBeNull();
    });

    it.each([
      ['darwin', 'sandbox-exec', 'seatbelt'],
      ['linux', 'bwrap', 'bubblewrap'],
    ] as const)('returns the %s runtime when %s is installed', async (platform, binary, name) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform);
      withBinary(binary);
      expect((await createSandboxRuntime())?.name).toBe(name);
    });

    it.each(['darwin', 'linux'] as const)('returns null on %s when the runtime binary is missing', async platform => {
      vi.spyOn(os, 'platform').mockReturnValue(platform);
      withBinary(null);
      expect(await createSandboxRuntime()).toBeNull();
    });
  });
});
