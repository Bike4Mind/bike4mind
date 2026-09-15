import { describe, it, expect, vi } from 'vitest';
import { detectPlatform, expandPath, isBinaryAvailable } from './SandboxRuntimeAdapter.js';
import os from 'os';

describe('SandboxRuntimeAdapter', () => {
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
