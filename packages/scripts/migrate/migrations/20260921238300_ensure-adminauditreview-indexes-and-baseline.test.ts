import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreateIndexes, mockDeleteMany, mockFind, mockFindByEntryIds, mockCreateMany } = vi.hoisted(() => ({
  mockCreateIndexes: vi.fn<() => Promise<string[]>>(),
  mockDeleteMany: vi.fn(),
  mockFind: vi.fn(),
  mockFindByEntryIds: vi.fn(),
  mockCreateMany: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  AdminAuditReviewModel: {
    createIndexes: () => mockCreateIndexes(),
    deleteMany: (...a: unknown[]) => mockDeleteMany(...a),
  },
  AdminAuditLogModel: { find: (...a: unknown[]) => mockFind(...a) },
  adminAuditReviewRepository: {
    findByEntryIds: (...a: unknown[]) => mockFindByEntryIds(...a),
    createMany: (...a: unknown[]) => mockCreateMany(...a),
  },
}));

import migration from './20260921238300_ensure-adminauditreview-indexes-and-baseline';

const NOW = new Date('2026-11-03T00:00:00.000Z');
const objectId = (hex: string) => ({ toString: () => hex });

const stubEntries = (ids: string[]) => {
  const query = {
    select: () => query,
    sort: () => query,
    lean: () => query,
    cursor: () => ({
      async *[Symbol.asyncIterator]() {
        for (const id of ids) yield { _id: objectId(id) };
      },
    }),
  };
  mockFind.mockReturnValue(query);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  mockCreateIndexes.mockReset().mockResolvedValue([]);
  mockDeleteMany.mockReset().mockResolvedValue({ deletedCount: 2 });
  mockFindByEntryIds.mockReset().mockResolvedValue([]);
  mockCreateMany
    .mockReset()
    .mockImplementation(async (reviews: Array<{ auditEntryId: string }>) => reviews.map(review => review.auditEntryId));
  stubEntries([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensure-adminauditreview-indexes-and-baseline', () => {
  it('builds the indexes and queries critical entries older than the baseline window', async () => {
    await migration.up();

    expect(mockCreateIndexes).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledWith({
      severity: 'critical',
      occurredAt: { $lt: new Date('2026-10-27T00:00:00.000Z') },
    });
  });

  it('baselines unreviewed entries in batches of 500 and skips ones that already have a review', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => index.toString(16).padStart(24, '0'));
    stubEntries(ids);
    mockFindByEntryIds.mockImplementation(async (batch: string[]) =>
      batch.includes(ids[0] ?? '') ? [{ auditEntryId: ids[0] }] : []
    );

    await migration.up();

    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    const firstBatch = mockCreateMany.mock.calls[0]?.[0] as Array<{ auditEntryId: string }>;
    expect(firstBatch).toHaveLength(499);
    expect(firstBatch.some(review => review.auditEntryId === ids[0])).toBe(false);
    expect(firstBatch[0]).toEqual({
      auditEntryId: ids[1],
      reviewer: { userId: null, name: 'Baseline' },
      baseline: true,
    });
    expect(mockCreateMany.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it('propagates an index build failure before touching reviews', async () => {
    mockCreateIndexes.mockRejectedValue(new Error('index build failed'));

    await expect(migration.up()).rejects.toThrow('index build failed');
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('removes only the baseline reviews on down', async () => {
    await migration.down();

    expect(mockDeleteMany).toHaveBeenCalledWith({ baseline: true });
  });
});
