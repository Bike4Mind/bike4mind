import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compareSemver } from './updateChecker.js';

// Mock axios and fs before importing the module functions that use them
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      access: vi.fn(),
      chmod: vi.fn(),
    },
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import axios from 'axios';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import {
  fetchLatestVersion,
  checkForUpdate,
  forceCheckForUpdate,
  isNpmPrefixWritable,
  getAutoUpdatePreference,
  setAutoUpdatePreference,
  shouldAttemptAutoUpdate,
} from './updateChecker.js';

const mockedAxios = vi.mocked(axios.get);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedMkdir = vi.mocked(fs.mkdir);
const mockedChmod = vi.mocked(fs.chmod);
const mockedAccess = vi.mocked(fs.access);
const mockedExecSync = vi.mocked(execSync);

describe('updateChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedChmod.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('compareSemver', () => {
    it('should return 0 for equal versions', () => {
      expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    });

    it('should return -1 when a < b (patch)', () => {
      expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    });

    it('should return 1 when a > b (patch)', () => {
      expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    });

    it('should return -1 when a < b (minor)', () => {
      expect(compareSemver('1.2.3', '1.3.0')).toBe(-1);
    });

    it('should return 1 when a > b (minor)', () => {
      expect(compareSemver('1.3.0', '1.2.9')).toBe(1);
    });

    it('should return -1 when a < b (major)', () => {
      expect(compareSemver('1.9.9', '2.0.0')).toBe(-1);
    });

    it('should return 1 when a > b (major)', () => {
      expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    });

    it('should handle versions with different segment counts', () => {
      expect(compareSemver('1.0', '1.0.0')).toBe(0);
      expect(compareSemver('1', '1.0.0')).toBe(0);
    });
  });

  describe('fetchLatestVersion', () => {
    it('should return version from NPM registry', async () => {
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.3.0' } });
      const result = await fetchLatestVersion();
      expect(result).toBe('0.3.0');
    });

    it('should return null on network error', async () => {
      mockedAxios.mockRejectedValueOnce(new Error('Network error'));
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });

    it('should return null if response has no version', async () => {
      mockedAxios.mockResolvedValueOnce({ data: {} });
      const result = await fetchLatestVersion();
      expect(result).toBeNull();
    });
  });

  describe('checkForUpdate', () => {
    it('should return cached result when cache is fresh', async () => {
      const cache = {
        lastChecked: new Date().toISOString(),
        latestVersion: '0.3.0',
        currentVersion: '0.2.28',
      };
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await checkForUpdate('0.2.28');
      expect(result).toEqual({
        currentVersion: '0.2.28',
        latestVersion: '0.3.0',
        updateAvailable: true,
      });
      // Should not have called axios since cache was fresh
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('should fetch from NPM when cache is stale', async () => {
      const staleCache = {
        lastChecked: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
        latestVersion: '0.2.29',
        currentVersion: '0.2.28',
      };
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(staleCache));
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.3.0' } });

      const result = await checkForUpdate('0.2.28');
      expect(result).toEqual({
        currentVersion: '0.2.28',
        latestVersion: '0.3.0',
        updateAvailable: true,
      });
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should fetch from NPM when cache does not exist', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.2.28' } });

      const result = await checkForUpdate('0.2.28');
      expect(result).toEqual({
        currentVersion: '0.2.28',
        latestVersion: '0.2.28',
        updateAvailable: false,
      });
    });

    it('should return null on network error with no cache', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockedAxios.mockRejectedValueOnce(new Error('Network error'));

      const result = await checkForUpdate('0.2.28');
      expect(result).toBeNull();
    });

    it('should detect when already on latest', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.2.28' } });

      const result = await checkForUpdate('0.2.28');
      expect(result?.updateAvailable).toBe(false);
    });

    it('should re-fetch when currentVersion changes from cached', async () => {
      const cache = {
        lastChecked: new Date().toISOString(),
        latestVersion: '0.3.0',
        currentVersion: '0.2.27', // Different from what we pass
      };
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(cache));
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.3.0' } });

      const result = await checkForUpdate('0.2.28');
      expect(mockedAxios).toHaveBeenCalledTimes(1);
      expect(result?.updateAvailable).toBe(true);
    });
  });

  describe('forceCheckForUpdate', () => {
    it('should always fetch from NPM regardless of cache', async () => {
      mockedAxios.mockResolvedValueOnce({ data: { version: '0.3.0' } });

      const result = await forceCheckForUpdate('0.2.28');
      expect(result).toEqual({
        currentVersion: '0.2.28',
        latestVersion: '0.3.0',
        updateAvailable: true,
      });
      expect(mockedAxios).toHaveBeenCalledTimes(1);
      // Should not have read cache
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('should return null on network error', async () => {
      mockedAxios.mockRejectedValueOnce(new Error('timeout'));

      const result = await forceCheckForUpdate('0.2.28');
      expect(result).toBeNull();
    });
  });

  describe('isNpmPrefixWritable', () => {
    it('returns true when the prefix exists and is writable', async () => {
      mockedExecSync.mockReturnValueOnce('/usr/local\n');
      mockedAccess.mockResolvedValueOnce(undefined);

      expect(await isNpmPrefixWritable()).toBe(true);
      expect(mockedAccess).toHaveBeenCalledWith('/usr/local', expect.any(Number));
    });

    it('returns false when the prefix is not writable (needs sudo)', async () => {
      mockedExecSync.mockReturnValueOnce('/usr/local\n');
      mockedAccess.mockRejectedValueOnce(new Error('EACCES'));

      expect(await isNpmPrefixWritable()).toBe(false);
    });

    it('returns false when the prefix cannot be determined', async () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('npm not found');
      });

      expect(await isNpmPrefixWritable()).toBe(false);
    });

    it('returns false when the prefix is empty', async () => {
      mockedExecSync.mockReturnValueOnce('   \n');

      expect(await isNpmPrefixWritable()).toBe(false);
      expect(mockedAccess).not.toHaveBeenCalled();
    });
  });

  describe('getAutoUpdatePreference', () => {
    it("defaults to 'ask' when no config file exists", async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      expect(await getAutoUpdatePreference()).toBe('ask');
    });

    it("defaults to 'ask' when the flag is absent", async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ preferences: { theme: 'dark' } }));
      expect(await getAutoUpdatePreference()).toBe('ask');
    });

    it("returns 'never' when explicitly disabled", async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ preferences: { autoUpdate: false } }));
      expect(await getAutoUpdatePreference()).toBe('never');
    });

    it("returns 'auto' when explicitly enabled", async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ preferences: { autoUpdate: true } }));
      expect(await getAutoUpdatePreference()).toBe('auto');
    });

    it("defaults to 'ask' on malformed JSON", async () => {
      mockedReadFile.mockResolvedValueOnce('{ not valid json');
      expect(await getAutoUpdatePreference()).toBe('ask');
    });
  });

  describe('setAutoUpdatePreference', () => {
    // Helper: parse the JSON payload written to the global config file.
    const writtenConfig = () => JSON.parse(mockedWriteFile.mock.calls[0][1] as string);

    it('writes autoUpdate=true (always) to the global config file, 0600', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT')); // no existing file
      await setAutoUpdatePreference(true);
      expect(writtenConfig()).toEqual({ preferences: { autoUpdate: true } });
      // Written to the GLOBAL config path (~/.bike4mind/config.json), 0600.
      expect(mockedWriteFile.mock.calls[0][0]).toContain('config.json');
      expect(mockedChmod).toHaveBeenCalledWith(expect.stringContaining('config.json'), 0o600);
    });

    it('writes autoUpdate=false (never) to the global config file', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      await setAutoUpdatePreference(false);
      expect(writtenConfig()).toEqual({ preferences: { autoUpdate: false } });
    });

    it('preserves existing global preferences when adding autoUpdate', async () => {
      mockedReadFile.mockResolvedValueOnce(
        JSON.stringify({ preferences: { theme: 'light', model: 'claude-sonnet-4-6' } })
      );
      await setAutoUpdatePreference(true);
      expect(writtenConfig()).toEqual({
        preferences: { theme: 'light', model: 'claude-sonnet-4-6', autoUpdate: true },
      });
    });

    // Regression for the project-config leak: setAutoUpdatePreference must NOT
    // route through ConfigStore (global->project->local merge), because that would
    // bake the *current project's* overrides into the user's GLOBAL config as a
    // bootstrap-time side effect. It reads/writes the global file directly, so
    // only what's already in the global file (plus autoUpdate) is persisted.
    it('does not leak project-merged config values into the global file', async () => {
      // The global file on disk only has theme:light. A project override of
      // theme:dark / model would be present in a ConfigStore.load() merge but
      // must never reach the written global file.
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ preferences: { theme: 'light' } }));
      await setAutoUpdatePreference(true);
      const written = writtenConfig();
      expect(written.preferences.theme).toBe('light'); // global value preserved
      expect(written.preferences.model).toBeUndefined(); // project override NOT pulled in
      expect(written.preferences.autoUpdate).toBe(true);
    });

    it('does not throw when the write fails (best-effort)', async () => {
      mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      mockedWriteFile.mockRejectedValueOnce(new Error('EROFS'));
      await expect(setAutoUpdatePreference(true)).resolves.toBeUndefined();
    });
  });

  describe('shouldAttemptAutoUpdate', () => {
    it('returns true on the happy path (TTY, no opt-out, not re-execed)', () => {
      expect(shouldAttemptAutoUpdate({ env: {}, isTTY: true })).toBe(true);
    });

    it('returns false when already re-execed', () => {
      expect(shouldAttemptAutoUpdate({ env: { B4M_UPDATED_REEXEC: '1' }, isTTY: true })).toBe(false);
    });

    it('returns false when opted out via B4M_AUTO_UPDATE=0', () => {
      expect(shouldAttemptAutoUpdate({ env: { B4M_AUTO_UPDATE: '0' }, isTTY: true })).toBe(false);
    });

    it('returns false when not attached to a TTY', () => {
      expect(shouldAttemptAutoUpdate({ env: {}, isTTY: false })).toBe(false);
    });
  });
});
