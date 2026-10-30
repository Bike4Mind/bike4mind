import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';

const mockListUserIdsAfter = vi.fn();
const mockFindCurrentStorageSize = vi.fn();
const mockLatestByUserIds = vi.fn();
const mockSetCurrentStorageIfUnchanged = vi.fn();
const mockSumFileSizeByUserId = vi.fn();
const mockListOrganizationIdsAfter = vi.fn();
const mockFindOrgCurrentStorageSize = vi.fn();
const mockSetOrgCurrentStorageIfUnchanged = vi.fn();
const mockSumFileSizeByOrganizationId = vi.fn();
const mockLatestByOrganizationIds = vi.fn();
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
  organizationRepository: {
    listOrganizationIdsAfter: (...args: unknown[]) => mockListOrganizationIdsAfter(...args),
    findCurrentStorageSize: (...args: unknown[]) => mockFindOrgCurrentStorageSize(...args),
    setCurrentStorageIfUnchanged: (...args: unknown[]) => mockSetOrgCurrentStorageIfUnchanged(...args),
  },
  fabFileRepository: {
    sumFileSizeByUserId: (...args: unknown[]) => mockSumFileSizeByUserId(...args),
    sumFileSizeByOrganizationId: (...args: unknown[]) => mockSumFileSizeByOrganizationId(...args),
  },
  storageDriftRecordRepository: {
    appendMany: (...args: unknown[]) => mockAppendMany(...args),
    latestByUserIds: (...args: unknown[]) => mockLatestByUserIds(...args),
    latestByOrganizationIds: (...args: unknown[]) => mockLatestByOrganizationIds(...args),
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
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitMetrics: (...args: unknown[]) => mockEmitMetrics(...args),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import {
  BATCH_SIZE,
  handler,
  optionsFromEnv,
  PASS_INTERVAL_MS,
  runStorageReconciliation,
  STATE_KEY,
  StorageReconciliationOptions,
} from './storageReconciliation';
import { connectDB } from '@bike4mind/database';

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
  // clearAllMocks keeps implementations; a leftover paging mock from an earlier test would loop forever.
  mockListUserIdsAfter.mockReset().mockResolvedValue([]);
  mockFindByKey.mockResolvedValue(null);
  mockSumFileSizeByUserId.mockResolvedValue(1000);
  mockSetCurrentStorageIfUnchanged.mockResolvedValue(true);
  mockFindCurrentStorageSize.mockResolvedValue(1000);
  mockLatestByUserIds.mockResolvedValue(new Map());
  mockListOrganizationIdsAfter.mockResolvedValue([]);
  mockFindOrgCurrentStorageSize.mockResolvedValue(1000);
  mockSumFileSizeByOrganizationId.mockResolvedValue(1000);
  mockSetOrgCurrentStorageIfUnchanged.mockResolvedValue(true);
  mockLatestByOrganizationIds.mockResolvedValue(new Map());
  mockPostMessageToSlack.mockResolvedValue(true);
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

  it('still posts the over-threshold alert when a later page throws after the cursor advanced', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(BATCH_SIZE)).mockRejectedValueOnce(new Error('mongo down'));
    mockSumFileSizeByUserId.mockResolvedValueOnce(1000 + 200 * MB);

    await expect(runStorageReconciliation(options())).rejects.toThrow('mongo down');

    expect(mockPostMessageToSlack).toHaveBeenCalledTimes(1);
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('user u0000');
  });

  it('leaves the ceiling alert unmarked when the Slack post fails, so a later run can retry it', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(3));
    mockSumFileSizeByUserId.mockResolvedValue(900);
    mockPostMessageToSlack.mockResolvedValue(false);

    await runStorageReconciliation(options({ driftedUserCeiling: 2 }));

    expect(mockPostMessageToSlack).toHaveBeenCalledTimes(1);
    expect(savedState().ceilingAlerted).toBe(false);
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

  it('resumes the pass across two hourly ticks without repairing', async () => {
    let clock = NOW;
    // The second list call crosses the 90s budget, so the first tick stops with a saved cursor.
    mockListUserIdsAfter.mockImplementation(async () => {
      clock += 60_000;
      return users(BATCH_SIZE);
    });

    const firstTick = await runStorageReconciliation(options({ now: () => clock, timeBudgetMs: 90_000 }));

    expect(firstTick).toMatchObject({ checked: BATCH_SIZE, passCompleted: false });
    const cursor = savedState();
    expect(cursor).toMatchObject({ phase: 'users', afterId: 'u0199', passCompletedAt: null });

    clock = NOW + 3_600_000;
    mockFindByKey.mockResolvedValue({ result: cursor });
    mockListUserIdsAfter.mockReset().mockResolvedValueOnce(users(1, BATCH_SIZE)).mockResolvedValue([]);
    // Non-zero drift with repair on: only the stability gate keeps the compare-and-set at the assertion below out of reach.
    mockSumFileSizeByUserId.mockResolvedValueOnce(400);

    const secondTick = await runStorageReconciliation(options({ now: () => clock, repair: true }));

    expect(mockListUserIdsAfter).toHaveBeenCalledExactlyOnceWith('u0199', BATCH_SIZE);
    expect(secondTick).toMatchObject({ checked: 1, passCompleted: true });
    expect(savedState()).toMatchObject({ checked: BATCH_SIZE + 1, passCompletedAt: new Date(clock).toISOString() });
    expect(mockSetCurrentStorageIfUnchanged).not.toHaveBeenCalled();
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

  it('advances the cursor past a chunk whose drift records fail to append', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockAppendMany.mockRejectedValueOnce(new Error('validation failed'));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runStorageReconciliation(options(), logger as unknown as Logger);

    expect(result).toMatchObject({ checked: 2, passCompleted: true });
    expect(savedState()).toMatchObject({ afterId: 'u0001' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('2 user drift record(s)'), expect.any(Error));
  });

  it('records drift and repairs nothing when metrics are off', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockSumFileSizeByUserId.mockResolvedValueOnce(400);

    const result = await runStorageReconciliation(options({ emitMetrics: false }));

    expect(mockAppendMany.mock.calls[0][0][0]).toMatchObject({
      userId: 'u0000',
      counter: 1000,
      truth: 400,
      drift: 600,
      repaired: false,
    });
    expect(mockSetCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(mockEmitMetrics).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, drifted: 1, repaired: 0 });
  });

  it('emits no metric on the skipped-pass path when metrics are off', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0002',
        passStartedAt: new Date(NOW - 60_000).toISOString(),
        passCompletedAt: new Date(NOW - 60_000).toISOString(),
        checked: 3,
        drifted: 0,
        ceilingAlerted: false,
      },
    });

    const result = await runStorageReconciliation(options({ emitMetrics: false }));

    expect(result.skipped).toBe(true);
    expect(mockEmitMetrics).not.toHaveBeenCalled();
  });

  it('still emits on both paths when emitMetrics is omitted', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    await runStorageReconciliation(options());
    expect(metric('StorageReconciliationRuns')).toBe(1);

    mockFindByKey.mockResolvedValue({
      result: {
        afterId: 'u0002',
        passStartedAt: new Date(NOW - 60_000).toISOString(),
        passCompletedAt: new Date(NOW - 60_000).toISOString(),
        checked: 3,
        drifted: 0,
        ceilingAlerted: false,
      },
    });
    mockEmitMetrics.mockClear();
    await runStorageReconciliation(options());
    expect(metric('StorageReconciliationRuns')).toBe(1);
  });
});

describe('organization phase', () => {
  const orgs = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => `o${String(offset + i).padStart(4, '0')}`);
  const stableOrgPrevious = (organizationId: string, counter: number, truth: number, ageMs = 24 * 60 * 60 * 1000) =>
    new Map([
      [organizationId, { organizationId, counter, truth, drift: counter - truth, checkedAt: new Date(NOW - ageMs) }],
    ]);

  it('runs after the user phase in the same pass and completes the pass only then', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(2));
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(3));

    const result = await runStorageReconciliation(options());

    expect(mockListOrganizationIdsAfter).toHaveBeenCalledWith(null, BATCH_SIZE);
    expect(mockListUserIdsAfter.mock.invocationCallOrder[0]).toBeLessThan(
      mockListOrganizationIdsAfter.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({ checked: 2, orgsChecked: 3, passCompleted: true });
    expect(savedState()).toMatchObject({
      phase: 'organizations',
      afterId: 'u0001',
      organizationAfterId: 'o0002',
      checked: 5,
      passCompletedAt: new Date(NOW).toISOString(),
    });
    expect(metric('StorageOrgsChecked')).toBe(3);
    expect(metric('StorageUsersChecked')).toBe(2);
  });

  it('does not complete the pass while the organization phase is unfinished', async () => {
    let clock = NOW;
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockListOrganizationIdsAfter.mockImplementation(async () => {
      clock += 60_000;
      return orgs(BATCH_SIZE);
    });

    const result = await runStorageReconciliation(options({ now: () => clock, timeBudgetMs: 90_000 }));

    expect(result.passCompleted).toBe(false);
    expect(savedState()).toMatchObject({ phase: 'organizations', passCompletedAt: null });
  });

  it('reads each org counter and truth by the org id', async () => {
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(1));

    await runStorageReconciliation(options());

    expect(mockFindOrgCurrentStorageSize).toHaveBeenCalledWith('o0000');
    expect(mockSumFileSizeByOrganizationId).toHaveBeenCalledWith('o0000');
    expect(mockFindCurrentStorageSize).not.toHaveBeenCalled();
    expect(mockSumFileSizeByUserId).not.toHaveBeenCalled();
  });

  it('writes org drift records carrying organizationId and no userId', async () => {
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(2));
    mockSumFileSizeByOrganizationId.mockResolvedValueOnce(1000).mockResolvedValueOnce(400);

    const result = await runStorageReconciliation(options());

    const records = mockAppendMany.mock.calls.at(-1)?.[0];
    expect(records[1]).toMatchObject({ organizationId: 'o0001', counter: 1000, truth: 400, drift: 600 });
    expect(records[1]).not.toHaveProperty('userId');
    expect(result).toMatchObject({ orgsChecked: 2, orgsDrifted: 1 });
    expect(metric('StorageOrgsDrifted')).toBe(1);
  });

  it('repairs an org only when its drift held still, by compare-and-set', async () => {
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(2));
    mockSumFileSizeByOrganizationId.mockResolvedValue(400);
    mockLatestByOrganizationIds.mockResolvedValueOnce(stableOrgPrevious('o0001', 1000, 400));

    const result = await runStorageReconciliation(options({ repair: true }));

    expect(mockSetOrgCurrentStorageIfUnchanged).toHaveBeenCalledTimes(1);
    expect(mockSetOrgCurrentStorageIfUnchanged).toHaveBeenCalledWith('o0001', 1000, 400);
    expect(mockSetCurrentStorageIfUnchanged).not.toHaveBeenCalled();
    expect(result.repaired).toBe(1);
  });

  it('labels org alert lines distinctly from user lines', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockSumFileSizeByUserId.mockResolvedValueOnce(1000 + 200 * MB);
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(1));
    mockSumFileSizeByOrganizationId.mockResolvedValueOnce(1000 + 300 * MB);

    await runStorageReconciliation(options());

    const message = mockPostMessageToSlack.mock.calls[0][0];
    expect(message).toContain('org o0000');
    expect(message).toContain('user u0000');
  });

  it('resumes a state stored before the phase existed as the user phase', async () => {
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
    mockListUserIdsAfter.mockResolvedValueOnce(users(1, 200));

    const result = await runStorageReconciliation(options());

    expect(mockListUserIdsAfter).toHaveBeenCalledWith('u0199', BATCH_SIZE);
    expect(mockListOrganizationIdsAfter).toHaveBeenCalledWith(null, BATCH_SIZE);
    expect(result.passCompleted).toBe(true);
  });

  it('resumes the organization phase from its own cursor without revisiting users', async () => {
    mockFindByKey.mockResolvedValue({
      result: {
        phase: 'organizations',
        afterId: 'u0001',
        organizationAfterId: 'o0099',
        passStartedAt: new Date(NOW - 60_000).toISOString(),
        passCompletedAt: null,
        checked: 102,
        drifted: 0,
        ceilingAlerted: false,
      },
    });
    mockListOrganizationIdsAfter.mockResolvedValueOnce(orgs(1, 100));

    await runStorageReconciliation(options());

    expect(mockListUserIdsAfter).not.toHaveBeenCalled();
    expect(mockListOrganizationIdsAfter).toHaveBeenCalledWith('o0099', BATCH_SIZE);
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
        STORAGE_DRIFT_CEILING_MIN_BYTES: '7',
      })
    ).toEqual({ repair: true, driftAlertBytes: 5000, driftedUserCeiling: 50, ceilingMinDriftBytes: 7 });
  });
});

describe('handler', () => {
  it('substitutes the stage into the Mongo URI and reports over-threshold users as a count', async () => {
    mockListUserIdsAfter.mockResolvedValueOnce(users(1));
    mockSumFileSizeByUserId.mockResolvedValueOnce(1000 + 200 * MB);

    const response = await handler({}, { awsRequestId: 'req-1' } as Context);

    expect(connectDB).toHaveBeenCalledWith('mongodb://test/test', expect.anything());
    const body = JSON.parse((response as { body: string }).body);
    expect(typeof body.overThreshold).toBe('number');
    expect(body.overThreshold).toBe(1);
    expect(body).toMatchObject({ checked: 1, drifted: 1, passCompleted: true });
  });
});
