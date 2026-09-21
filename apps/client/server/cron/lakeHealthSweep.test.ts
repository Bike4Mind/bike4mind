import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFind = vi.fn();
const mockUpsertSnapshot = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  dataLakeRepository: { find: (...args: unknown[]) => mockFind(...args) },
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
    mockFind.mockResolvedValue([]);
    mockComputeLakeHealth.mockResolvedValue(healthResult());
    mockUpsertSnapshot.mockResolvedValue(undefined);
  });

  it('reports zero scanned when there are no active lakes', async () => {
    const result = await handler();
    expect(result).toEqual({ status: 'OK', scanned: 0, failed: 0, truncated: false });
    expect(mockComputeLakeHealth).not.toHaveBeenCalled();
  });

  it('scopes the scan to active lakes only', async () => {
    await handler();
    const [filter] = mockFind.mock.calls[0];
    expect(filter.status).toBe('active');
  });

  it('computes and persists health for each active lake', async () => {
    mockFind.mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);

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
  });

  it('isolates a per-lake failure so the rest of the run still completes', async () => {
    mockFind.mockResolvedValueOnce([lake({ id: 'lake-fail' }), lake({ id: 'lake-ok' })]).mockResolvedValueOnce([]);
    mockComputeLakeHealth.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(healthResult());

    const result = await handler();

    expect(result).toEqual({ status: 'OK', scanned: 2, failed: 1, truncated: false });
    expect(mockUpsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it('paginates by cursor across multiple pages until a short page ends the scan', async () => {
    // PAGE_SIZE is 100: a full first page implies "there may be more", so only a page shorter
    // than what was asked for ends the scan.
    const firstPage = Array.from({ length: 100 }, (_, i) => lake({ id: `lake-${i + 1}` }));
    mockFind.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([lake({ id: 'lake-101' })]);

    const result = await handler();

    expect(result.scanned).toBe(101);
    expect(mockFind).toHaveBeenCalledTimes(2);
    // Second page's cursor is the last id of the first page.
    const [secondFilter] = mockFind.mock.calls[1];
    expect(secondFilter._id).toEqual({ $gt: 'lake-100' });
  });

  it('emits the run metric even when the scan itself throws', async () => {
    mockFind.mockRejectedValue(new Error('cannot reach primary'));

    await expect(handler()).rejects.toThrow('cannot reach primary');

    expect(metricValue('LakeHealthSweepRuns')).toBe(1);
  });
});
