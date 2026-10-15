import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListUserIdsAfter = vi.fn();
const mockFindCurrentStorageSize = vi.fn();
const mockLatestByUserIds = vi.fn();
const mockSetCurrentStorageIfUnchanged = vi.fn();
const mockSumFileSizeByUserId = vi.fn();
const mockAppendMany = vi.fn();
const mockFindByKey = vi.fn();
const mockCreateOrUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  userRepository: {
    listUserIdsAfter: (...args: unknown[]) => mockListUserIdsAfter(...args),
    findCurrentStorageSize: (...args: unknown[]) => mockFindCurrentStorageSize(...args),
    setCurrentStorageIfUnchanged: (...args: unknown[]) => mockSetCurrentStorageIfUnchanged(...args),
  },
  fabFileRepository: { sumFileSizeByUserId: (...args: unknown[]) => mockSumFileSizeByUserId(...args) },
  storageDriftRecordRepository: {
    appendMany: (...args: unknown[]) => mockAppendMany(...args),
    latestByUserIds: (...args: unknown[]) => mockLatestByUserIds(...args),
  },
  cacheRepository: {
    findByKey: (...args: unknown[]) => mockFindByKey(...args),
    createOrUpdate: (...args: unknown[]) => mockCreateOrUpdate(...args),
  },
}));

const mockPostMessageToSlack = vi.fn();
vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostMessageToSlack(...args),
}));

const mockEmitMetrics = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetrics: (...args: unknown[]) => mockEmitMetrics(...args),
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import {
  BATCH_SIZE,
  optionsFromEnv,
  PASS_INTERVAL_MS,
  runStorageReconciliation,
  STATE_KEY,
  StorageReconciliationOptions,
} from './storageReconciliation';

const MB = 1024 * 1024;
const NOW = Date.parse('2026-10-15T06:00:00Z');
const options = (overrides: Partial<StorageReconciliationOptions> = {}): StorageReconciliationOptions => ({
  repair: false,
  driftAlertBytes: 100 * MB,
  driftedUserCeiling: 50,
  ceilingMinDriftBytes: 1,
  now: () => NOW,
  ...overrides,
});

const users = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `u${String(offset + i).padStart(4, '0')}`);

const savedState = () => mockCreateOrUpdate.mock.calls.at(-1)?.[0].result;
const metric = (name: string) =>
  (mockEmitMetrics.mock.calls.at(-1)?.[1] as Array<{ name: string; value: number }>).find(m => m.name === name)?.value;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByKey.mockResolvedValue(null);
  mockSumFileSizeByUserId.mockResolvedValue(1000);
  mockSetCurrentStorageIfUnchanged.mockResolvedValue(true);
  mockFindCurrentStorageSize.mockResolvedValue(1000);
  mockLatestByUserIds.mockResolvedValue(new Map());
});

const stablePrevious = (userId: string, counter: number, truth: number, ageMs = 24 * 60 * 60 * 1000) =>
  new Map([[userId, { userId, counter, truth, drift: counter - truth, checkedAt: new Date(NOW - ageMs) }]]);

describe('runStorageReconciliation', () => {
  it('records every checked user and completes the pass in dry-run without writing counters', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId.mockResolvedValueOnce(1000).mockResolvedValueOnce(400).mockResolvedValueOnce(1000);

    const result = await runStorageReconciliation(options());

    expect(mockListUserIdsAfter).toHaveBeenCalledWith(null, BATCH_SIZE);
    const records = mockAppendMany.mock.calls[0][0];
    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({ userId: 'u0001', counter: 1000, truth: 400, drift: 600, repaired: false });
    expect(records[1].checkedAt).toEqual(new Date(NOW));
    expect(mockSetCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 3, drifted: 1, repaired: 0, passCompleted: true });
    expect(savedState()).toMatchObject({ afterId: 'u0002', passCompletedAt: new Date(NOW).toISOString() });
    expect(mockCreateOrUpdate.mock.calls.at(-1)?.[0].key).toBe(STATE_KEY);
  });

  it('repairs drift that held still since the previous pass, by compare-and-set', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockSumFileSizeByUserId.mockResolvedValueOnce(1000).mockResolvedValueOnce(400);
    mockLatestByUserIds.mockResolvedValueOnce(stablePrevious('u0001', 1000, 400));

    const result = await runStorageReconciliation(options({ repair: true }));

    expect(mockSetCurrentStorageIfUnchanged).toHaveBeenCalledTimes(1);
    expect(mockSetCurrentStorageIfUnchanged).toHaveBeenCalledWith('u0001', 1000, 400);
    expect(result.repaired).toBe(1);
  });

  it('counts a lost compare-and-set as a conflict, not a repair', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockSumFileSizeByUserId.mockResolvedValueOnce(400);
    mockLatestByUserIds.mockResolvedValueOnce(stablePrevious('u0000', 1000, 400));
    mockSetCurrentStorageIfUnchanged.mockResolvedValueOnce(false);

    const result = await runStorageReconciliation(options({ repair: true }));

    expect(result).toMatchObject({ repaired: 0, conflicts: 1 });
    expect(mockAppendMany.mock.calls[0][0][0]).toMatchObject({ repaired: false, conflict: true });
  });

  it('alerts on users whose drift exceeds the threshold, in either direction', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId
      .mockResolvedValueOnce(1000 + 200 * MB)
      .mockResolvedValueOnce(1000 - 1)
      .mockResolvedValueOnce(1000);

    const result = await runStorageReconciliation(options());

    expect(result.overThreshold.map(r => r.userId)).toEqual(['u0000']);
    expect(mockPostMessageToSlack).toHaveBeenCalledTimes(1);
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('user u0000');
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('dry run');
    expect(metric('StorageDriftOverThreshold')).toBe(1);
  });

  it('does not alert when every drift is under the threshold', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockSumFileSizeByUserId.mockResolvedValue(900);

    await runStorageReconciliation(options());

    expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    expect(metric('StorageUsersDrifted')).toBe(2);
  });

  it('alerts once per pass when the drifted-user count crosses the ceiling', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId.mockResolvedValue(900);

    await runStorageReconciliation(options({ driftedUserCeiling: 2 }));

    expect(mockPostMessageToSlack).toHaveBeenCalledTimes(1);
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('widespread');
    expect(savedState().ceilingAlerted).toBe(true);
  });

  it('does not repeat the ceiling alert for a pass that already raised it', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0002',
        passStartedAt: new Date(NOW - 60_000).toISOString(),
        passCompletedAt: null,
        checked: 3,
        drifted: 3,
        ceilingAlerted: true,
      },
    });
    mockListUserIdsAfter.mockResolvedValueOnce(users(1, 3));
    mockSumFileSizeByUserId.mockResolvedValue(900);

    await runStorageReconciliation(options({ driftedUserCeiling: 2 }));

    expect(mockPostMessageToSlack).not.toHaveBeenCalled();
  });

  it('resumes from the persisted cursor and stops at the time budget without completing', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0199',
        passStartedAt: new Date(NOW - 60_000).toISOString(),
        passCompletedAt: null,
        checked: 200,
        drifted: 0,
        ceilingAlerted: false,
      },
    });
    let clock = NOW;
    mockListUserIdsAfter.mockImplementation(async () => {
      clock += 60_000;
      return users(BATCH_SIZE, 200);
    });

    const result = await runStorageReconciliation(options({ now: () => clock, timeBudgetMs: 90_000 }));

    expect(mockListUserIdsAfter).toHaveBeenNthCalledWith(1, 'u0199', BATCH_SIZE);
    expect(mockListUserIdsAfter).toHaveBeenCalledTimes(2);
    expect(result.passCompleted).toBe(false);
    expect(savedState()).toMatchObject({ afterId: 'u0399', checked: 400, passCompletedAt: null });
  });

  it('skips while the completed pass is younger than the pass interval', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0002',
        passStartedAt: new Date(NOW - PASS_INTERVAL_MS + 60_000).toISOString(),
        passCompletedAt: new Date(NOW - 60_000).toISOString(),
        checked: 3,
        drifted: 0,
        ceilingAlerted: false,
      },
    });

    const result = await runStorageReconciliation(options());

    expect(result.skipped).toBe(true);
    expect(mockListUserIdsAfter).not.toHaveBeenCalled();
  });

  it('starts a fresh pass from the beginning once the interval has elapsed', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0002',
        passStartedAt: new Date(NOW - PASS_INTERVAL_MS).toISOString(),
        passCompletedAt: new Date(NOW - PASS_INTERVAL_MS + 60_000).toISOString(),
        checked: 3,
        drifted: 3,
        ceilingAlerted: true,
      },
    });
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));

    await runStorageReconciliation(options());

    expect(mockListUserIdsAfter).toHaveBeenCalledWith(null, BATCH_SIZE);
    expect(savedState()).toMatchObject({ checked: 1, drifted: 0, ceilingAlerted: false });
  });

  it.each([
    ['first sighting', new Map()],
    ['counter moved since last pass', stablePrevious('u0000', 900, 400)],
    ['truth moved since last pass', stablePrevious('u0000', 1000, 500)],
    ['previous check too recent', stablePrevious('u0000', 1000, 400, 60_000)],
  ])('records but does not repair drift on %s', async (_label, previous) => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockSumFileSizeByUserId.mockResolvedValueOnce(400);
    mockLatestByUserIds.mockResolvedValueOnce(previous);

    const result = await runStorageReconciliation(options({ repair: true }));

    expect(mockSetCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ drifted: 1, repaired: 0, conflicts: 0 });
  });

  it('skips a user deleted between listing and check', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockFindCurrentStorageSize.mockResolvedValueOnce(null);

    const result = await runStorageReconciliation(options());

    expect(result).toMatchObject({ checked: 1, failed: 0 });
  });

  it('keeps the cursor when every check in a chunk fails, so the next run retries', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId.mockRejectedValue(new Error('mongo down'));

    const result = await runStorageReconciliation(options());

    expect(result).toMatchObject({ checked: 0, failed: 3, passCompleted: false });
    expect(mockAppendMany).not.toHaveBeenCalled();
    expect(mockCreateOrUpdate).not.toHaveBeenCalled();
  });

  it('stops mid-page at the time budget and saves the cursor at the last finished chunk', async () => {
    let clock = NOW;
    mockListUserIdsAfter.mockResolvedValueOnce(users(BATCH_SIZE));
    mockSumFileSizeByUserId.mockImplementation(async () => {
      clock += 1_000;
      return 1000;
    });

    const result = await runStorageReconciliation(options({ now: () => clock, timeBudgetMs: 25_000 }));

    expect(result.passCompleted).toBe(false);
    expect(result.checked).toBe(30);
    expect(savedState()).toMatchObject({ afterId: 'u0029', checked: 30, passCompletedAt: null });
  });

  it('counts only drift of at least ceilingMinDriftBytes toward the ceiling', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId.mockResolvedValue(999);

    const result = await runStorageReconciliation(options({ driftedUserCeiling: 2, ceilingMinDriftBytes: MB }));

    expect(result.drifted).toBe(3);
    expect(savedState().drifted).toBe(0);
    expect(mockPostMessageToSlack).not.toHaveBeenCalled();
  });

  it('keeps going past a user whose check throws', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockSumFileSizeByUserId.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(1000);

    const result = await runStorageReconciliation(options());

    expect(result).toMatchObject({ checked: 1, failed: 1, passCompleted: true });
    expect(metric('StorageReconciliationFailures')).toBe(1);
  });
});

describe('optionsFromEnv', () => {
  it('defaults to a dry run', () => {
    expect(optionsFromEnv({})).toEqual({
      repair: false,
      driftAlertBytes: 100 * MB,
      driftedUserCeiling: 50,
      ceilingMinDriftBytes: MB,
    });
  });

  it('reads overrides and ignores invalid numbers', () => {
    expect(
      optionsFromEnv({
        STORAGE_RECONCILIATION_REPAIR: 'true',
        STORAGE_DRIFT_ALERT_BYTES: '5000',
        STORAGE_DRIFTED_USER_CEILING: 'abc',
      })
    ).toEqual({ repair: true, driftAlertBytes: 5000, driftedUserCeiling: 50, ceilingMinDriftBytes: MB });
  });
});
