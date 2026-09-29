import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  order: [] as string[],
  connFindById: vi.fn(),
  claimForSync: vi.fn(),
  adoptSyncClaim: vi.fn(),
  renewSyncClaim: vi.fn(),
  releaseSyncClaim: vi.fn(),
  recordSynced: vi.fn(),
  lakeFindById: vi.fn(),
  batchFindById: vi.fn(),
  userFindById: vi.fn(),
  getSettingByName: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  getInstallationOctokit: vi.fn(),
  getRepository: vi.fn(),
  getBranchHeadSha: vi.fn(),
  runGitHubLakeSlice: vi.fn(),
  settle: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById },
  adminSettingsRepository: {},
  dataLakeRepository: { findById: h.lakeFindById },
  dataLakeBatchRepository: { findById: h.batchFindById },
  orgGitHubLakeConnectionRepository: {
    findById: h.connFindById,
    claimForSync: h.claimForSync,
    adoptSyncClaim: h.adoptSyncClaim,
    renewSyncClaim: h.renewSyncClaim,
    releaseSyncClaim: h.releaseSyncClaim,
    recordSynced: h.recordSynced,
  },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingByName: h.getSettingByName,
}));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/github/dataLake/lakeAppClient')>()),
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
  getInstallationOctokit: h.getInstallationOctokit,
  getRepository: h.getRepository,
  getBranchHeadSha: h.getBranchHeadSha,
}));
vi.mock('@server/queueHandlers/githubLakeSlice', () => ({ runGitHubLakeSlice: h.runGitHubLakeSlice }));
vi.mock('@server/queueHandlers/lakeIngestShared', () => ({ settleLakeIngestBatch: h.settle }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));

import {
  dispatch,
  GITHUB_LAKE_CHAIN_BUDGET_MS,
  GITHUB_LAKE_RECONNECT_MESSAGE,
  MAX_GITHUB_LAKE_DEFERRALS,
  MAX_GITHUB_LAKE_REDRIVES,
  MAX_GITHUB_LAKE_SLICES,
} from './githubLakeIngest';

const QUEUE_URL = 'https://sqs.test/githubLakeIngestQueue';
const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const run = (body: Record<string, unknown> = { connectionId: 'conn1' }) =>
  dispatch({ Records: [{ body: JSON.stringify(body) }] } as never, {} as never, logger);
const CONNECTION = {
  id: 'conn1',
  targetDataLakeId: 'lake1',
  connectedBy: 'user1',
  installationId: 42,
  repositoryId: 7,
  repositoryFullName: 'acme/docs',
  status: 'connected',
  enabled: true,
  lastSyncedCommitSha: 'old-sha',
};
const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
const continuation = (over: Record<string, unknown> = {}) => ({
  connectionId: 'conn1',
  slice: 1,
  commitSha: 'pinned-sha',
  resumeBatchId: 'batch1',
  claimToken: 'tok-prev',
  chainStartedAt: Date.now(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.connFindById.mockResolvedValue(CONNECTION);
  h.claimForSync.mockResolvedValue('tok-claim');
  h.adoptSyncClaim.mockResolvedValue('tok-adopt');
  h.renewSyncClaim.mockImplementation(async () => {
    h.order.push('renew');
    return 'tok-renew';
  });
  h.releaseSyncClaim.mockResolvedValue({ id: 'conn1' });
  h.recordSynced.mockResolvedValue({ id: 'conn1' });
  h.lakeFindById.mockResolvedValue({ id: 'lake1', status: 'active', datalakeTag: 'datalake:lake1' });
  h.batchFindById.mockImplementation(async (id: string) => ({ id, dataLakeId: 'lake1', status: 'processing' }));
  h.userFindById.mockResolvedValue({ id: 'user1' });
  h.getSettingByName.mockResolvedValue(true);
  h.getGitHubLakeAppConfig.mockReturnValue({
    appId: 'a',
    slug: 's',
    privateKey: 'k',
    clientId: 'c',
    clientSecret: 'x',
  });
  h.getInstallationOctokit.mockResolvedValue({});
  h.getRepository.mockResolvedValue({ fullName: 'acme/docs', defaultBranch: 'main' });
  h.getBranchHeadSha.mockResolvedValue('head-sha');
  h.runGitHubLakeSlice.mockResolvedValue({ kind: 'done', batchId: 'batch1', transientSkips: 0 });
  h.sendToQueue.mockImplementation(async () => void h.order.push('enqueue'));
});

describe('githubLakeIngest - claim', () => {
  it('defers behind a live sync, forwarding the continuation identity whole', async () => {
    h.adoptSyncClaim.mockResolvedValue(null);
    h.claimForSync.mockResolvedValue(null);
    h.connFindById.mockResolvedValue({ ...CONNECTION, status: 'syncing' });
    const body = {
      connectionId: 'conn1',
      manual: true,
      redriveCount: 0,
      deferCount: 2,
      slice: 3,
      commitSha: 'pinned-sha',
      resumeBatchId: 'batch1',
      claimToken: 'tok-prev',
      chainStartedAt: 1_000,
    };
    await run(body);
    expect(h.sendToQueue).toHaveBeenCalledWith(QUEUE_URL, { ...body, redriveCount: 1 }, 90);
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
  });

  it('drops a duplicate when no sync is in flight', async () => {
    h.claimForSync.mockResolvedValue(null);
    await run();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
  });

  it('stops redriving at the cap', async () => {
    h.claimForSync.mockResolvedValue(null);
    h.connFindById.mockResolvedValue({ ...CONNECTION, status: 'syncing' });
    await run({ connectionId: 'conn1', redriveCount: MAX_GITHUB_LAKE_REDRIVES });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

describe('githubLakeIngest - gates', () => {
  it('drops a disabled connection after claiming, releasing it unchanged', async () => {
    h.connFindById.mockResolvedValue({ ...CONNECTION, enabled: false });
    await run();
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
  });

  it('keeps an error state and its message when a drop releases', async () => {
    h.connFindById.mockResolvedValue({ ...CONNECTION, enabled: false, status: 'error', lastError: 'reconnect' });
    await run();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', 'reconnect', 'error');
  });

  it('drops when the GitHub source flag is off', async () => {
    h.getSettingByName.mockImplementation(async (key: string) => key !== 'EnableDataLakeGitHub');
    await run();
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('drops when the lake is no longer ingestable and settles a continuation batch', async () => {
    h.lakeFindById.mockResolvedValue({ id: 'lake1', status: 'archived', datalakeTag: 'datalake:lake1' });
    await run(continuation());
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
  });

  it('drops a malformed payload without claiming', async () => {
    await expect(run({ nope: true })).resolves.toBeUndefined();
    await expect(run({ connectionId: 'conn1', resumeBatchId: 'batch1' })).resolves.toBeUndefined();
    expect(h.claimForSync).not.toHaveBeenCalled();
  });
});

describe('githubLakeIngest - HEAD', () => {
  it('is a no-op when HEAD matches the last synced commit and the run is not manual', async () => {
    h.getBranchHeadSha.mockResolvedValue('old-sha');
    await run();
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
  });

  it('diffs anyway on a manual re-sync at the same HEAD', async () => {
    h.getBranchHeadSha.mockResolvedValue('old-sha');
    await run({ connectionId: 'conn1', manual: true });
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'old-sha' }));
  });

  it('reads the pinned commit on a continuation, not the current HEAD', async () => {
    await run(continuation());
    expect(h.adoptSyncClaim).toHaveBeenCalledWith('conn1', 'batch1', 'tok-prev');
    expect(h.getBranchHeadSha).not.toHaveBeenCalled();
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'pinned-sha', resumeBatchId: 'batch1', repoFullName: 'acme/docs' })
    );
  });

  it('treats an empty repository as nothing to sync, not a lost installation', async () => {
    h.getBranchHeadSha.mockRejectedValue(httpError(404));
    await run();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-claim',
      expect.stringContaining('no commits'),
      'connected'
    );
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
  });
});

describe('githubLakeIngest - errors', () => {
  it('parks the connection in error when the repository read 404s', async () => {
    h.getRepository.mockRejectedValue(httpError(404));
    await expect(run()).resolves.toBeUndefined();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', GITHUB_LAKE_RECONNECT_MESSAGE, 'error');
  });

  it('parks the connection in error when the token mint says the repository left the installation (422)', async () => {
    h.getInstallationOctokit.mockRejectedValue(httpError(422));
    await expect(run()).resolves.toBeUndefined();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', GITHUB_LAKE_RECONNECT_MESSAGE, 'error');
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('parks the connection in error on a 404 mid-slice without rethrowing', async () => {
    h.runGitHubLakeSlice.mockRejectedValue(httpError(404));
    await expect(run()).resolves.toBeUndefined();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', GITHUB_LAKE_RECONNECT_MESSAGE, 'error');
  });

  it('releases with the failure and rethrows anything else for SQS retry', async () => {
    h.runGitHubLakeSlice.mockRejectedValue(new Error('mongo down'));
    await expect(run()).rejects.toThrow('mongo down');
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', 'mongo down', 'connected');
  });

  it('releases a deterministic refusal with its message and does not rethrow', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'refused', batchId: 'batch1', message: 'too large' });
    await expect(run()).resolves.toBeUndefined();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', 'too large', 'connected');
  });
});

describe('githubLakeIngest - finish', () => {
  it('records the commit on a clean finish', async () => {
    await run();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.recordSynced).toHaveBeenCalledWith('conn1', 'tok-claim', { commitSha: 'head-sha', defaultBranch: 'main' });
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
  });

  it('does not advance the commit when files were skipped for a transient reason', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'done', batchId: 'batch1', transientSkips: 2 });
    await run();
    expect(h.recordSynced).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-claim',
      expect.stringContaining('storage limit'),
      'connected'
    );
  });
});

describe('githubLakeIngest - yield', () => {
  it('hands a deadline slice off with the pinned commit and a renewed claim', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: 'batch1', remaining: 4 });
    await run();
    expect(h.order).toEqual(['renew', 'enqueue']);
    expect(h.renewSyncClaim).toHaveBeenCalledWith('conn1', 'batch1', 'tok-claim');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      {
        connectionId: 'conn1',
        manual: false,
        slice: 1,
        deferCount: 0,
        commitSha: 'head-sha',
        resumeBatchId: 'batch1',
        claimToken: 'tok-renew',
        chainStartedAt: expect.any(Number),
      },
      undefined
    );
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
    expect(h.recordSynced).not.toHaveBeenCalled();
  });

  it('renews the claim, then defers a rate-limited slice by the computed delay', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({
      kind: 'rate_limited',
      batchId: 'batch1',
      delaySeconds: 900,
      remaining: 3,
    });
    await run();
    expect(h.order).toEqual(['renew', 'enqueue']);
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      expect.objectContaining({
        slice: 0,
        deferCount: 1,
        commitSha: 'head-sha',
        resumeBatchId: 'batch1',
        claimToken: 'tok-renew',
      }),
      900
    );
  });

  it('releases and comes back fresh when throttled before any batch existed', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'rate_limited', batchId: null, delaySeconds: 60, remaining: 0 });
    await run();
    expect(h.renewSyncClaim).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      { connectionId: 'conn1', manual: false, slice: 0, deferCount: 1, chainStartedAt: expect.any(Number) },
      60
    );
  });

  it('sheds a throttled token mint as a fresh deferral', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 300);
    h.getInstallationOctokit.mockRejectedValue(
      httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })
    );
    await run();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      expect.objectContaining({ deferCount: 1 }),
      expect.any(Number)
    );
  });

  it(`refuses past ${MAX_GITHUB_LAKE_DEFERRALS} deferrals`, async () => {
    h.runGitHubLakeSlice.mockResolvedValue({
      kind: 'rate_limited',
      batchId: 'batch1',
      delaySeconds: 900,
      remaining: 3,
    });
    await run(continuation({ deferCount: MAX_GITHUB_LAKE_DEFERRALS }));
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-adopt',
      expect.stringContaining('rate-limited'),
      'connected'
    );
  });

  it(`refuses at ${MAX_GITHUB_LAKE_SLICES} slices`, async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: 'batch1', remaining: 3 });
    await run(continuation({ slice: MAX_GITHUB_LAKE_SLICES - 1 }));
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-adopt',
      expect.stringContaining('20 continuation runs'),
      'connected'
    );
  });

  it('refuses once the chain is past its 3-hour budget', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: 'batch1', remaining: 3 });
    await run(continuation({ chainStartedAt: Date.now() - GITHUB_LAKE_CHAIN_BUDGET_MS - 1 }));
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-adopt',
      expect.stringContaining('3-hour'),
      'connected'
    );
  });

  it('ends the chain when the renew loses', async () => {
    h.renewSyncClaim.mockResolvedValue(null);
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: 'batch1', remaining: 3 });
    await run();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.releaseSyncClaim).toHaveBeenCalledWith(
      'conn1',
      'tok-claim',
      'Sync stopped before it finished. Re-sync to continue.',
      'connected'
    );
    expect(h.recordSynced).not.toHaveBeenCalled();
  });
});

describe('githubLakeIngest - chain safety', () => {
  const STARTED = Date.now() - 60_000;

  it('runs the slice as the connecting user', async () => {
    const user = { id: 'user1', email: 'owner@example.com' };
    h.userFindById.mockResolvedValue(user);
    await run();
    expect(h.userFindById).toHaveBeenCalledWith('user1');
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(expect.objectContaining({ user }));
  });

  it('releases and re-enqueues a deadline hit before any batch existed, carrying the chain', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: null, remaining: 40 });
    await run({ connectionId: 'conn1', manual: true, slice: 2, deferCount: 3, chainStartedAt: STARTED });
    expect(h.renewSyncClaim).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      { connectionId: 'conn1', manual: true, slice: 3, deferCount: 3, chainStartedAt: STARTED },
      undefined
    );
    expect(h.recordSynced).not.toHaveBeenCalled();
  });

  it('ignores a stale pin on a fresh message that wins claimForSync and diffs at the current HEAD', async () => {
    await run({ connectionId: 'conn1', slice: 2, deferCount: 1, commitSha: 'stale-sha', chainStartedAt: STARTED });
    expect(h.adoptSyncClaim).not.toHaveBeenCalled();
    expect(h.getBranchHeadSha).toHaveBeenCalledWith({}, 'acme/docs', 'main');
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'head-sha' }));
    expect(h.recordSynced).toHaveBeenCalledWith('conn1', 'tok-claim', { commitSha: 'head-sha', defaultBranch: 'main' });
  });

  it('ignores the pin of a continuation whose adopt failed and which then won claimForSync', async () => {
    h.adoptSyncClaim.mockResolvedValue(null);
    await run(continuation({ slice: 3 }));
    expect(h.claimForSync).toHaveBeenCalledWith('conn1');
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.getBranchHeadSha).toHaveBeenCalled();
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'head-sha', resumeBatchId: undefined })
    );
    expect(h.recordSynced).toHaveBeenCalledWith('conn1', 'tok-claim', { commitSha: 'head-sha', defaultBranch: 'main' });
  });

  it('settles the old batch on a not-manual no-op exit for a failed-adopt continuation', async () => {
    h.adoptSyncClaim.mockResolvedValue(null);
    h.getBranchHeadSha.mockResolvedValue('old-sha');
    await run(continuation({ slice: 3 }));
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.runGitHubLakeSlice).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
  });

  it('still honours the pin on an adopted continuation', async () => {
    await run(continuation({ slice: 3 }));
    expect(h.claimForSync).not.toHaveBeenCalled();
    expect(h.getBranchHeadSha).not.toHaveBeenCalled();
    expect(h.runGitHubLakeSlice).toHaveBeenCalledWith(expect.objectContaining({ commitSha: 'pinned-sha' }));
    expect(h.recordSynced).toHaveBeenCalledWith('conn1', 'tok-adopt', {
      commitSha: 'pinned-sha',
      defaultBranch: 'main',
    });
  });

  it('does not hand off a batch under an untrusted pin when throttled before HEAD resolves', async () => {
    h.adoptSyncClaim.mockResolvedValue(null);
    h.getInstallationOctokit.mockRejectedValue(httpError(429, { 'retry-after': '30' }));
    await run(continuation({ slice: 3, deferCount: 1, chainStartedAt: STARTED }));
    expect(h.renewSyncClaim).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith('batch1', logger);
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-claim', null, 'connected');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      { connectionId: 'conn1', manual: false, slice: 3, deferCount: 2, chainStartedAt: STARTED },
      30
    );
  });

  it('keeps the caps on a throttled token mint mid-chain by renewing and handing the batch off', async () => {
    h.getInstallationOctokit.mockRejectedValue(httpError(429, { 'retry-after': '120' }));
    await run(continuation({ slice: 4, deferCount: 2, chainStartedAt: STARTED }));
    expect(h.order).toEqual(['renew', 'enqueue']);
    expect(h.renewSyncClaim).toHaveBeenCalledWith('conn1', 'batch1', 'tok-adopt');
    expect(h.sendToQueue).toHaveBeenCalledWith(
      QUEUE_URL,
      {
        connectionId: 'conn1',
        manual: false,
        slice: 4,
        deferCount: 3,
        commitSha: 'pinned-sha',
        resumeBatchId: 'batch1',
        claimToken: 'tok-renew',
        chainStartedAt: STARTED,
      },
      120
    );
    expect(h.releaseSyncClaim).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('never settles or hands off a batch id the slice echoed but did not adopt', async () => {
    h.batchFindById.mockResolvedValue({ id: 'batch1', dataLakeId: 'other-lake', status: 'processing' });
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'deadline', batchId: 'batch1', remaining: 5 });
    await run(continuation());
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.renewSyncClaim).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-adopt', null, 'connected');
    const [, body] = h.sendToQueue.mock.calls[0];
    expect(body).not.toHaveProperty('resumeBatchId');
    expect(body).not.toHaveProperty('commitSha');
    expect(body).toMatchObject({ slice: 2 });
  });

  it('does not settle a refusal whose batch is already terminal', async () => {
    h.batchFindById.mockResolvedValue({ id: 'batch1', dataLakeId: 'lake1', status: 'completed' });
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'refused', batchId: 'batch1', message: 'too large' });
    await run(continuation());
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.releaseSyncClaim).toHaveBeenCalledWith('conn1', 'tok-adopt', 'too large', 'connected');
  });

  it('settles nothing when a finished slice created no batch', async () => {
    h.runGitHubLakeSlice.mockResolvedValue({ kind: 'done', batchId: null, transientSkips: 0 });
    await run();
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.recordSynced).toHaveBeenCalledWith('conn1', 'tok-claim', { commitSha: 'head-sha', defaultBranch: 'main' });
  });

  it('does not advance the commit on a refusal, a yield, or a throw', async () => {
    for (const outcome of [
      { kind: 'refused', batchId: 'batch1', message: 'no' },
      { kind: 'deadline', batchId: 'batch1', remaining: 1 },
      { kind: 'rate_limited', batchId: 'batch1', delaySeconds: 60, remaining: 1 },
    ]) {
      h.runGitHubLakeSlice.mockResolvedValueOnce(outcome);
      await run();
    }
    h.runGitHubLakeSlice.mockRejectedValueOnce(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(h.recordSynced).not.toHaveBeenCalled();
  });
});
