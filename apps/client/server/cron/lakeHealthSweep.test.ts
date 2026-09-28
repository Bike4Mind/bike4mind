import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindDue = vi.fn();
const mockHasMoreDue = vi.fn();
const mockMarkHealthChecked = vi.fn();
const mockUpsertSnapshot = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  dataLakeRepository: {
    findDueForHealthCheck: (...args: unknown[]) => mockFindDue(...args),
    hasMoreDueForHealthCheck: (...args: unknown[]) => mockHasMoreDue(...args),
    markHealthChecked: (...args: unknown[]) => mockMarkHealthChecked(...args),
  },
  fabFileRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  memoryLedgerRepository: {},
  dataLakeHealthSnapshotRepository: { upsertSnapshot: (...args: unknown[]) => mockUpsertSnapshot(...args) },
}));

const mockComputeLakeHealth = vi.fn();
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { computeLakeHealth: (...args: unknown[]) => mockComputeLakeHealth(...args) },
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%' },
}));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

const mockEmitMetric = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  StandardUnit: { Count: 'Count' },
}));

import { handler } from './lakeHealthSweep';

const lake = (overrides: Record<string, unknown> = {}) => ({
  id: 'lake-1',
  status: 'active',
  datalakeTag: 'tag-1',
  organizationId: null,
  lastHealthCheckedAt: null,
  ...overrides,
});

const healthResult = (overrides: Record<string, unknown> = {}) => ({
  serving: { status: 'active', servesRetrieval: true },
  reachableShare: 0.9,
  coverage: { measuredMembers: 5, membersWithChunks: 5 },
  predicates: {
    chunkWithinPolicy: { pass: 5, fail: 0, unknown: 0 },
    chunkCountConsistent: { pass: 5, fail: 0, unknown: 0 },
    fullyVectorized: { pass: 5, fail: 0, unknown: 0 },
    serveCapMeetsPolicy: 'pass',
  },
  affectedMemberCount: 0,
  scanTruncated: false,
  duplicateMembers: { memberCount: 0, groupCount: 0, groups: [] },
  lakeMemory: { state: 'current' },
  inconsistency: null,
  ...overrides,
});

const metricValue = (name: string) => mockEmitMetric.mock.calls.find(call => call[1] === name)?.[2];

describe('lakeHealthSweep cron', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): a test that queues a mockResolvedValueOnce the handler
    // never consumes (e.g. because pagination stopped after one page) would otherwise leak that
    // queued value into the next test - clearAllMocks only clears call history, not the queue.
    vi.resetAllMocks();
    mockFindDue.mockResolvedValue([]);
    mockHasMoreDue.mockResolvedValue(false);
    mockComputeLakeHealth.mockResolvedValue(healthResult());
    mockUpsertSnapshot.mockResolvedValue(undefined);
    mockMarkHealthChecked.mockResolvedValue(undefined);
  });

  it('reports zero scanned when there are no active lakes', async () => {
    const result = await handler();
    expect(result).toEqual({ status: 'OK', scanned: 0, failed: 0, truncated: false });
    expect(mockComputeLakeHealth).not.toHaveBeenCalled();
  });

  it('starts the scan with no cursor and a page-sized limit', async () => {
    await handler();
    expect(mockFindDue.mock.calls[0][0]).toMatchObject({ cursor: null, limit: 100 });
  });

  it('excludes its own stamp from the candidate set, so a lake it graded cannot be regraded', async () => {
    // The scan sorts on the field the run mutates as it walks, so a lake already graded this run
    // re-enters the candidate set behind an older cursor unless the query excludes this exact
    // stamp. Same Date the run passes to markHealthChecked, or the exclusion misses.
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

    await handler();

    const stamped = mockMarkHealthChecked.mock.calls[0][1];
    for (const [params] of mockFindDue.mock.calls) {
      expect(params.excludeCheckedAt).toBe(stamped);
    }
  });

  it('computes and persists health for each active lake, then stamps it as checked', async () => {
    mockFindDue.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', scanned: 1, failed: 0, truncated: false });
    expect(mockComputeLakeHealth).toHaveBeenCalledTimes(1);
    expect(mockUpsertSnapshot).toHaveBeenCalledTimes(1);
    expect(mockUpsertSnapshot.mock.calls[0][0]).toMatchObject({
      lakeId: 'lake-1',
      status: 'active',
      servesRetrieval: true,
      reachableShare: 0.9,
    });
    expect(mockMarkHealthChecked).toHaveBeenCalledTimes(1);
    expect(mockMarkHealthChecked).toHaveBeenCalledWith('lake-1', expect.any(Date));
  });

  it('isolates a per-lake failure so the rest of the run still completes', async () => {
    mockFindDue.mockResolvedValueOnce([lake({ id: 'lake-fail' }), lake({ id: 'lake-ok' })]).mockResolvedValueOnce([]);
    mockComputeLakeHealth.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(healthResult());

    const result = await handler();

    expect(result).toEqual({ status: 'OK', scanned: 2, failed: 1, truncated: false });
    expect(mockUpsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('stamps lastHealthCheckedAt even for a lake whose grading failed, so it rotates to the back next run', async () => {
    mockFindDue.mockResolvedValueOnce([lake({ id: 'lake-fail' })]).mockResolvedValueOnce([]);
    mockComputeLakeHealth.mockRejectedValueOnce(new Error('boom'));

    const result = await handler();

    expect(result.failed).toBe(1);
    // A lake stuck failing forever must still lose its "never checked" priority - otherwise it
    // (and everything capped behind it) starves, which is the exact fairness bug being fixed.
    expect(mockMarkHealthChecked).toHaveBeenCalledWith('lake-fail', expect.any(Date));
  });

  it('paginates by a staleness+id keyset across multiple pages until a short page ends the scan', async () => {
    // PAGE_SIZE is 100: a full first page implies "there may be more", so only a page shorter
    // than what was asked for ends the scan.
    const checkedAt = new Date('2024-01-01T00:00:00Z');
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      lake({ id: `lake-${i + 1}`, lastHealthCheckedAt: checkedAt })
    );
    mockFindDue
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([lake({ id: 'lake-101', lastHealthCheckedAt: null })]);

    const result = await handler();

    expect(result.scanned).toBe(101);
    expect(mockFindDue).toHaveBeenCalledTimes(2);
    // Second page's keyset cursor is (lastHealthCheckedAt, _id) of the first page's last row, not
    // just `_id` - the scan order is staleness, so the cursor has to track that field too.
    expect(mockFindDue.mock.calls[1][0].cursor).toEqual({ lastHealthCheckedAt: checkedAt, id: 'lake-100' });
  });

  it('caps a run at MAX_LAKES_PER_RUN and reports the deferred remainder as truncated', async () => {
    // 20 full pages of 100 is the cap exactly; the remainder probe is what says whether anything
    // was actually left behind.
    const page = Array.from({ length: 100 }, (_, i) => lake({ id: `lake-${i}` }));
    mockFindDue.mockResolvedValue(page);
    mockHasMoreDue.mockResolvedValue(true);

    const result = await handler();

    expect(result.scanned).toBe(2000);
    expect(result.truncated).toBe(true);
    expect(mockFindDue).toHaveBeenCalledTimes(20);
  });

  it('does not report truncated when the fleet size is an exact multiple of the cap', async () => {
    // The cap stopped the loop and the last page was full, but nothing is left over - reporting a
    // deferred remainder here would be a standing false alarm at any exact multiple of the cap.
    const page = Array.from({ length: 100 }, (_, i) => lake({ id: `lake-${i}` }));
    mockFindDue.mockResolvedValue(page);
    mockHasMoreDue.mockResolvedValue(false);

    const result = await handler();

    expect(result.scanned).toBe(2000);
    expect(result.truncated).toBe(false);
  });

  it('emits the run metric even when the scan itself throws', async () => {
    mockFindDue.mockRejectedValue(new Error('cannot reach primary'));

    await expect(handler()).rejects.toThrow('cannot reach primary');

    expect(metricValue('LakeHealthSweepRuns')).toBe(1);
  });
});
