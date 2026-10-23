import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectPlatform,
  expandPath,
  getProtectedWorkspacePaths,
  isBinaryAvailable,
  resolveSandboxPath,
} from './SandboxRuntimeAdapter.js';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';

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

    it('returns false for a nonexistent binary', () => {
      expect(isBinaryAvailable('nonexistent-binary-that-should-not-exist-12345')).toBe(false);
    });
  });
});
