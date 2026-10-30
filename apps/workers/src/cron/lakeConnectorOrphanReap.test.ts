import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  findOrphanedDrive: vi.fn(),
  findOrphanedGitHub: vi.fn(),
  releaseDriveConnection: vi.fn(),
  releaseGitHubLakeConnection: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  connectDB: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  orgGoogleDriveConnectionRepository: { findOrphaned: h.findOrphanedDrive },
  orgGitHubLakeConnectionRepository: { findOrphaned: h.findOrphanedGitHub },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = h.loggerInfo;
    warn = vi.fn();
    error = h.loggerError;
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%/db' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));
vi.mock('@server/integrations/google/drive/common', () => ({ releaseDriveConnection: h.releaseDriveConnection }));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  releaseGitHubLakeConnection: h.releaseGitHubLakeConnection,
}));
vi.mock('@bike4mind/server-utils/integrations/github/dataLake/lakeAppClient', () => ({
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));

import { runLakeConnectorOrphanReap, MAX_REAPS_PER_CONNECTOR, RUN_BUDGET_MS } from './lakeConnectorOrphanReap';

const APP_CONFIG = { appId: 'app' };
const flagsOn = (...off: string[]) =>
  h.getSettingsValue.mockImplementation(
    async (key: string) => ['EnableDataLakes', 'EnableDataLakeGitHub'].includes(key) && !off.includes(key)
  );

const orgDrive = { id: 'drive-org', organizationId: 'org-1', connectedBy: 'user-1', targetDataLakeId: 'gone-1' };
const personalDrive = { id: 'drive-personal', connectedBy: 'user-2', targetDataLakeId: 'gone-2' };
const ghA = { id: 'gh-a', organizationId: 'org-1', installationId: 1, targetDataLakeId: 'gone-3' };
const ghB = { id: 'gh-b', organizationId: 'org-2', installationId: 2, targetDataLakeId: 'gone-4' };

beforeEach(() => {
  vi.clearAllMocks();
  flagsOn();
  h.findOrphanedDrive.mockResolvedValue([orgDrive, personalDrive]);
  h.findOrphanedGitHub.mockResolvedValue([ghA, ghB]);
  h.releaseDriveConnection.mockResolvedValue(true);
  h.releaseGitHubLakeConnection.mockResolvedValue({ installationRetained: false });
  h.getGitHubLakeAppConfig.mockReturnValue(APP_CONFIG);
});

describe('runLakeConnectorOrphanReap', () => {
  it('releases every orphan with its owner and the App config, bounded per connector', async () => {
    const result = await runLakeConnectorOrphanReap();

    expect(h.findOrphanedDrive).toHaveBeenCalledWith(MAX_REAPS_PER_CONNECTOR);
    expect(h.findOrphanedGitHub).toHaveBeenCalledWith(MAX_REAPS_PER_CONNECTOR);
    expect(h.releaseDriveConnection.mock.calls).toEqual([
      ['drive-org', { kind: 'organization', organizationId: 'org-1' }],
      ['drive-personal', { kind: 'user', userId: 'user-2' }],
    ]);
    expect(h.releaseGitHubLakeConnection.mock.calls).toEqual([
      [ghA, APP_CONFIG],
      [ghB, APP_CONFIG],
    ]);
    expect(result).toEqual({
      drive: { found: 2, released: 2, failed: 0, deferred: 0 },
      github: { found: 2, released: 2, failed: 0, deferred: 0 },
    });
  });

  it('keeps going past a failed release and logs it with the connection id', async () => {
    h.releaseDriveConnection.mockRejectedValueOnce(new Error('google down'));
    h.releaseGitHubLakeConnection.mockRejectedValueOnce(new Error('GitHub lake App is not configured'));

    const result = await runLakeConnectorOrphanReap();

    expect(h.releaseDriveConnection).toHaveBeenCalledTimes(2);
    expect(h.releaseGitHubLakeConnection).toHaveBeenCalledTimes(2);
    expect(result.drive).toEqual({ found: 2, released: 1, failed: 1, deferred: 0 });
    expect(result.github).toEqual({ found: 2, released: 1, failed: 1, deferred: 0 });
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('failed to release'),
      expect.objectContaining({ connector: 'drive', connectionId: 'drive-org', error: 'google down' })
    );
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('failed to release'),
      expect.objectContaining({ connector: 'github', connectionId: 'gh-a' })
    );
  });

  it('still runs the GitHub leg when the Drive scan throws', async () => {
    h.findOrphanedDrive.mockRejectedValueOnce(new Error('mongo blip'));

    const result = await runLakeConnectorOrphanReap();

    expect(result.drive).toEqual({ found: 0, released: 0, failed: 0, deferred: 0, scanFailed: true });
    expect(result.github).toEqual({ found: 2, released: 2, failed: 0, deferred: 0 });
  });

  it('starts no release past the run budget and reports the rest as deferred', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    // The first Drive release eats the whole budget, so nothing after it may start.
    h.releaseDriveConnection.mockImplementationOnce(async () => {
      clock.mockReturnValue(start + RUN_BUDGET_MS + 1);
      return true;
    });

    const result = await runLakeConnectorOrphanReap();
    clock.mockRestore();

    expect(h.releaseDriveConnection).toHaveBeenCalledTimes(1);
    expect(h.releaseGitHubLakeConnection).not.toHaveBeenCalled();
    expect(result.drive).toEqual({ found: 2, released: 1, failed: 0, deferred: 1 });
    expect(result.github).toEqual({ found: 2, released: 0, failed: 0, deferred: 2 });
  });

  it('does nothing when EnableDataLakes is off', async () => {
    flagsOn('EnableDataLakes');

    const result = await runLakeConnectorOrphanReap();

    expect(result.disabled).toBe(true);
    expect(h.findOrphanedDrive).not.toHaveBeenCalled();
    expect(h.findOrphanedGitHub).not.toHaveBeenCalled();
    expect(h.releaseDriveConnection).not.toHaveBeenCalled();
    expect(h.releaseGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('skips only the GitHub leg when EnableDataLakeGitHub is off', async () => {
    flagsOn('EnableDataLakeGitHub');

    const result = await runLakeConnectorOrphanReap();

    expect(h.releaseDriveConnection).toHaveBeenCalledTimes(2);
    expect(h.findOrphanedGitHub).not.toHaveBeenCalled();
    expect(h.releaseGitHubLakeConnection).not.toHaveBeenCalled();
    expect(h.getGitHubLakeAppConfig).not.toHaveBeenCalled();
    expect(result.github).toEqual({ found: 0, released: 0, failed: 0, deferred: 0, skipped: true });
  });

  it('logs the summary even when there is nothing to reap', async () => {
    h.findOrphanedDrive.mockResolvedValue([]);
    h.findOrphanedGitHub.mockResolvedValue([]);

    await runLakeConnectorOrphanReap();

    expect(h.loggerInfo).toHaveBeenCalledWith(expect.stringContaining('sweep complete'), {
      drive: { found: 0, released: 0, failed: 0, deferred: 0 },
      github: { found: 0, released: 0, failed: 0, deferred: 0 },
    });
  });
});
