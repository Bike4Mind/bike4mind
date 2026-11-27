import { Logger } from '@bike4mind/observability';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  connect: (() => Promise.resolve()) as () => Promise<void>,
  settings: {} as Record<string, unknown>,
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: () => state.connect(),
  adminSettingsRepository: {},
}));
// EnableArtifacts falls back to its schema default (on), as the real getSettingsValue does.
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => state.settings,
  getSettingsValue: (key: string, settings: Record<string, unknown>) =>
    key in settings ? settings[key] : key === 'EnableArtifacts' ? true : undefined,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://db.example.com/%STAGE%', STAGE: 'test' },
}));

import { loadPythonArtifactDataOrigins } from './pythonArtifactDataOrigins';

describe('loadPythonArtifactDataOrigins', () => {
  beforeEach(() => {
    state.connect = () => Promise.resolve();
    state.settings = {};
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the canonical list for a valid stored value', async () => {
    state.settings = { pythonArtifactDataOrigins: ['https://Data.example.org/'] };
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({
      origins: ['https://data.example.org'],
      degraded: false,
    });
  });

  it('returns nothing while Artifacts is turned off', async () => {
    state.settings = { EnableArtifacts: false, pythonArtifactDataOrigins: ['https://data.example.org'] };
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({ origins: [], degraded: false });
  });

  it('returns nothing when the setting is unset', async () => {
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({ origins: [], degraded: false });
  });

  it('returns nothing when any stored entry is invalid', async () => {
    state.settings = { pythonArtifactDataOrigins: ['https://data.example.org', 'https://169.254.169.254'] };
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({ origins: [], degraded: false });
  });

  it("returns nothing when an entry names the app's own site", async () => {
    state.settings = { pythonArtifactDataOrigins: ['https://data.example.org', 'https://api.example.com'] };
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({ origins: [], degraded: false });
  });

  it('returns nothing when the database cannot be reached', async () => {
    state.connect = () => Promise.reject(new Error('connection refused'));
    state.settings = { pythonArtifactDataOrigins: ['https://data.example.org'] };
    await expect(loadPythonArtifactDataOrigins()).resolves.toEqual({ origins: [], degraded: true });
  });

  it('returns nothing when the read does not answer in time', async () => {
    vi.useFakeTimers();
    state.connect = () => new Promise(() => {});
    const pending = loadPythonArtifactDataOrigins();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({ origins: [], degraded: true });
  });
});
