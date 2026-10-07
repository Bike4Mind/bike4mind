import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  findDueForReconcile: vi.fn(),
  markReconcileChecked: vi.fn(),
  markReconcileEnqueued: vi.fn(),
  sendToQueue: vi.fn(),
  connectDB: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  getInstallationOctokit: vi.fn(),
  getRepository: vi.fn(),
  getBranchHeadSha: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  orgGitHubLakeConnectionRepository: {
    findDueForReconcile: h.findDueForReconcile,
    markReconcileChecked: h.markReconcileChecked,
    markReconcileEnqueued: h.markReconcileEnqueued,
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%/db' } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' }, githubLakeIngestQueue: { url: 'gh-ingest-queue-url' } },
}));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/github/dataLake/lakeAppClient')>();
  return {
    gitHubErrorStatus: actual.gitHubErrorStatus,
    gitHubRateLimitDelaySeconds: actual.gitHubRateLimitDelaySeconds,
    getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
    getInstallationOctokit: h.getInstallationOctokit,
    getRepository: h.getRepository,
    getBranchHeadSha: h.getBranchHeadSha,
  };
});

import { runGitHubLakeReconcile, MAX_CHECKS_PER_RUN, RETRY_COOLDOWN_MS } from './githubLakeReconcile';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const FLAGS = ['EnableDataLakes', 'EnableDataLakeGitHub', 'EnableDataLakeGitHubReconcile'];
const flagsOn = (except?: string) =>
  h.getSettingsValue.mockImplementation(async (key: string) => FLAGS.includes(key) && key !== except);

type ConnFields = {
  installationId: number;
  lastSyncedCommitSha: string;
  status: string;
  reconcileEnqueuedSha: string | null;
  reconcileEnqueuedAt: Date;
};
const conn = (id: string, fields: Partial<ConnFields> = {}) => ({
  id,
  installationId: 1,
  repositoryId: Number(id.replace(/\D/g, '')) || 9,
  repositoryFullName: `acme/${id}`,
  lastSyncedCommitSha: 'old',
  status: 'connected',
  ...fields,
});

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
const rateLimited = () =>
  httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 600) });

const stamped = () => h.markReconcileChecked.mock.calls.flatMap(c => c[0] as string[]);
const enqueuedIds = () => h.sendToQueue.mock.calls.map(c => (c[1] as { connectionId: string }).connectionId);

describe('githubLakeReconcile cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagsOn();
    h.getGitHubLakeAppConfig.mockReturnValue({ appId: 'a', privateKey: 'k' });
    h.getInstallationOctokit.mockImplementation(async (_c, installationId: number, repositoryId: number) => ({
      installationId,
      repositoryId,
    }));
    h.getRepository.mockImplementation(async (_o, fullName: string) => ({ fullName, defaultBranch: 'main' }));
    h.getBranchHeadSha.mockResolvedValue('new');
    h.sendToQueue.mockResolvedValue(undefined);
    h.markReconcileChecked.mockResolvedValue(undefined);
    h.markReconcileEnqueued.mockResolvedValue(undefined);
    h.findDueForReconcile.mockResolvedValue([]);
  });

  it.each(FLAGS)('does nothing when %s is off', async flag => {
    flagsOn(flag);
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(result.disabled).toBe(true);
    expect(h.findDueForReconcile).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('does nothing when the GitHub lake App is not configured', async () => {
    h.getGitHubLakeAppConfig.mockReturnValue(null);
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(result).toMatchObject({ checked: 0, enqueued: 0 });
    expect(h.findDueForReconcile).not.toHaveBeenCalled();
  });

  it('enqueues a non-manual sync only when HEAD moved, and stamps both', async () => {
    h.findDueForReconcile.mockResolvedValue([conn('c1'), conn('c2', { lastSyncedCommitSha: 'new' })]);
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(h.findDueForReconcile).toHaveBeenCalledWith(MAX_CHECKS_PER_RUN);
    expect(MAX_CHECKS_PER_RUN).toBe(200);
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith('gh-ingest-queue-url', { connectionId: 'c1', manual: false });
    expect(result).toMatchObject({ checked: 2, enqueued: 1, unchanged: 1, failed: 0 });
    expect(stamped()).toEqual(['c1', 'c2']);
    expect(h.markReconcileChecked.mock.calls[0][1]).toEqual(new Date(NOW));
  });

  it('enqueues a never-synced connection', async () => {
    h.findDueForReconcile.mockResolvedValue([{ ...conn('c1'), lastSyncedCommitSha: undefined }]);
    expect((await runGitHubLakeReconcile({ now: NOW })).enqueued).toBe(1);
  });

  it('skips an empty repository (branch 404 after the repository resolved)', async () => {
    h.findDueForReconcile.mockResolvedValue([conn('c1')]);
    h.getBranchHeadSha.mockRejectedValue(httpError(404));
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(result).toMatchObject({ skipped: 1, enqueued: 0, failed: 0 });
    expect(stamped()).toEqual(['c1']);
  });

  it.each([
    ['token mint 422', () => h.getInstallationOctokit.mockRejectedValue(httpError(422))],
    ['token mint 404', () => h.getInstallationOctokit.mockRejectedValue(httpError(404))],
    ['repository 404', () => h.getRepository.mockRejectedValue(httpError(404))],
    ['repository 422', () => h.getRepository.mockRejectedValue(httpError(422))],
  ])('enqueues once on lost access (%s) so the ingest records it', async (_label, arrange) => {
    h.findDueForReconcile.mockResolvedValue([conn('c1')]);
    arrange();
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(enqueuedIds()).toEqual(['c1']);
    expect(result).toMatchObject({ enqueued: 1, failed: 0 });
    expect(h.markReconcileEnqueued).toHaveBeenCalledWith('c1', null, new Date(NOW));
  });

  it('isolates one failing connection from its siblings', async () => {
    h.findDueForReconcile.mockResolvedValue([conn('c1'), conn('c2'), conn('c3')]);
    h.getBranchHeadSha.mockImplementation(async (_o, fullName: string) => {
      if (fullName === 'acme/c2') throw httpError(500);
      return 'new';
    });
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(enqueuedIds()).toEqual(['c1', 'c3']);
    expect(result).toMatchObject({ checked: 3, enqueued: 2, failed: 1 });
    expect(stamped()).toEqual(['c1', 'c2', 'c3']);
  });

  it('a rate limit skips the rest of that installation only, but still stamps them so others rotate in', async () => {
    // 11 connections so the second window starts after the throttle was recorded.
    const sameInstall = Array.from({ length: 11 }, (_, i) => conn(`a${i + 1}`, { installationId: 1 }));
    const otherInstall = conn('b1', { installationId: 2 });
    h.findDueForReconcile.mockResolvedValue([...sameInstall, otherInstall]);
    h.getBranchHeadSha.mockImplementation(async (_o, fullName: string) => {
      if (fullName === 'acme/a1') throw rateLimited();
      return 'new';
    });
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(result.throttledInstallations).toBe(1);
    expect(result.checked).toBe(10);
    expect(stamped()).toEqual(expect.arrayContaining(['a1', 'a11', 'b1']));
    expect(enqueuedIds()).toContain('b1');
    expect(enqueuedIds()).not.toContain('a11');
    expect(h.getInstallationOctokit).toHaveBeenCalledTimes(11);
  });

  it('does not re-enqueue the same HEAD on a second pass within the cooldown, but does after it', async () => {
    // A row store the mocked repository reads and writes, so pass 2 sees what pass 1 recorded.
    const row = conn('c1');
    h.findDueForReconcile.mockImplementation(async () => [{ ...row }]);
    h.markReconcileEnqueued.mockImplementation(async (_id: string, sha: string | null, at: Date) => {
      Object.assign(row, { reconcileEnqueuedSha: sha, reconcileEnqueuedAt: at });
    });

    expect((await runGitHubLakeReconcile({ now: NOW })).enqueued).toBe(1);
    // The ingest released without recording the commit, so lastSyncedCommitSha is still 'old'.
    const second = await runGitHubLakeReconcile({ now: NOW + 15 * 60_000 });
    expect(second).toMatchObject({ enqueued: 0, backoff: 1, checked: 1 });
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);

    expect((await runGitHubLakeReconcile({ now: NOW + RETRY_COOLDOWN_MS })).enqueued).toBe(1);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
  });

  it('enqueues a new HEAD even inside the cooldown of an earlier one', async () => {
    h.findDueForReconcile.mockResolvedValue([
      conn('c1', { reconcileEnqueuedSha: 'older', reconcileEnqueuedAt: new Date(NOW - 60_000) }),
    ]);
    expect((await runGitHubLakeReconcile({ now: NOW })).enqueued).toBe(1);
    expect(h.markReconcileEnqueued).toHaveBeenCalledWith('c1', 'new', new Date(NOW));
  });

  it('backs off a lost-access re-enqueue the same way', async () => {
    h.findDueForReconcile.mockResolvedValue([
      conn('c1', { reconcileEnqueuedSha: null, reconcileEnqueuedAt: new Date(NOW - 60_000) }),
    ]);
    h.getRepository.mockRejectedValue(httpError(404));
    expect(await runGitHubLakeReconcile({ now: NOW })).toMatchObject({ enqueued: 0, backoff: 1 });
  });

  it('enqueues a stale syncing claim even when HEAD is unchanged, so the ingest releases it', async () => {
    h.findDueForReconcile.mockResolvedValue([conn('c1', { status: 'syncing', lastSyncedCommitSha: 'new' })]);
    expect(await runGitHubLakeReconcile({ now: NOW })).toMatchObject({ enqueued: 1, unchanged: 0 });
  });

  it('stamps each window as it finishes and stops starting windows once the run budget is spent', async () => {
    h.findDueForReconcile.mockResolvedValue(Array.from({ length: 15 }, (_, i) => conn(`c${i + 1}`)));
    const result = await runGitHubLakeReconcile({ now: NOW, budgetMs: 0 });
    expect(result).toMatchObject({ checked: 10, notReached: 5 });
    expect(h.markReconcileChecked).toHaveBeenCalledTimes(1);
    expect(stamped()).toHaveLength(10);
    expect(stamped()).not.toContain('c11');

    vi.clearAllMocks();
    await runGitHubLakeReconcile({ now: NOW });
    expect(h.markReconcileChecked).toHaveBeenCalledTimes(2);
    expect(stamped()).toHaveLength(15);
  });

  it('counts an enqueue failure and still stamps the connection', async () => {
    h.findDueForReconcile.mockResolvedValue([conn('c1'), conn('c2')]);
    h.sendToQueue.mockRejectedValueOnce(new Error('sqs down'));
    const result = await runGitHubLakeReconcile({ now: NOW });
    expect(result).toMatchObject({ checked: 2, enqueued: 1, failed: 1 });
    expect(stamped()).toEqual(['c1', 'c2']);
  });
});
