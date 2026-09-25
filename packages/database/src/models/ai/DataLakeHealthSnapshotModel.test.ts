import { describe, it, expect, beforeEach } from 'vitest';
import {
  DataLakeHealthSnapshotModel,
  dataLakeHealthSnapshotRepository,
  DATA_LAKE_HEALTH_SNAPSHOT_RETENTION_DAYS,
} from './DataLakeHealthSnapshotModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  // setupMongoTest's beforeEach drops the database (and its unique index) - re-sync so the
  // upsert-on-conflict path is actually exercised against the real constraint.
  await DataLakeHealthSnapshotModel.syncIndexes();
});

const snapshotInput = (
  overrides: Partial<Parameters<typeof dataLakeHealthSnapshotRepository.upsertSnapshot>[0]> = {}
) => ({
  lakeId: 'lake-1',
  organizationId: null,
  snapshotDate: '2026-09-21',
  computedAt: new Date('2026-09-21T06:00:00Z'),
  status: 'active' as const,
  servesRetrieval: true,
  reachableShare: 0.9,
  measuredMembers: 10,
  membersWithChunks: 10,
  predicates: {
    chunkWithinPolicy: { pass: 10, fail: 0, unknown: 0 },
    chunkCountConsistent: { pass: 10, fail: 0, unknown: 0 },
    fullyVectorized: { pass: 10, fail: 0, unknown: 0 },
  },
  serveCapMeetsPolicy: true,
  affectedMemberCount: 0,
  scanTruncated: false,
  duplicateMemberCount: 0,
  duplicateGroupCount: 0,
  lakeMemoryState: 'current' as const,
  inconsistencyFindingCount: null,
  ...overrides,
});

describe('DataLakeHealthSnapshotRepository.upsertSnapshot', () => {
  it('inserts a new row for a lake seen for the first time on a given day', async () => {
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput());

    const rows = await DataLakeHealthSnapshotModel.find({ lakeId: 'lake-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reachableShare).toBe(0.9);
  });

  it('overwrites the same day row on a re-run instead of duplicating it', async () => {
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ reachableShare: 0.5 }));
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ reachableShare: 0.9 }));

    const rows = await DataLakeHealthSnapshotModel.find({ lakeId: 'lake-1', snapshotDate: '2026-09-21' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reachableShare).toBe(0.9);
  });

  it('creates a distinct row for the next day rather than overwriting', async () => {
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-21' }));
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-22' }));

    const rows = await DataLakeHealthSnapshotModel.find({ lakeId: 'lake-1' }).sort({ snapshotDate: 1 });
    expect(rows.map(r => r.snapshotDate)).toEqual(['2026-09-21', '2026-09-22']);
  });

  it('derives expiresAt from computedAt plus the retention window, not from the caller', async () => {
    const computedAt = new Date('2026-09-21T06:00:00Z');
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ computedAt }));

    const [row] = await DataLakeHealthSnapshotModel.find({ lakeId: 'lake-1' });
    const expected = new Date(computedAt.getTime() + DATA_LAKE_HEALTH_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(row.expiresAt.getTime()).toBe(expected.getTime());
  });
});

describe('DataLakeHealthSnapshotRepository.getTrend', () => {
  it('returns a lake history newest-first', async () => {
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-19' }));
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-20' }));
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-21' }));

    const trend = await dataLakeHealthSnapshotRepository.getTrend('lake-1');
    expect(trend.map(r => r.snapshotDate)).toEqual(['2026-09-21', '2026-09-20', '2026-09-19']);
  });

  it('respects a limit', async () => {
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-19' }));
    await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate: '2026-09-20' }));

    const trend = await dataLakeHealthSnapshotRepository.getTrend('lake-1', { limit: 1 });
    expect(trend).toHaveLength(1);
    expect(trend[0].snapshotDate).toBe('2026-09-20');
  });

  it('applies the default limit when the caller names none, instead of returning unbounded history', async () => {
    // 92 rows: one more than DEFAULT_TREND_LIMIT (90, not exported - a quarter of daily points).
    // `if (opts?.limit) query.limit(opts.limit)` used to skip `.limit()` entirely whenever no limit
    // was given, so a lake's WHOLE history came back on every call - unbounded, growing with the
    // lake's age.
    const dates = Array.from({ length: 92 }, (_, i) => {
      const d = new Date('2026-01-01T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    for (const snapshotDate of dates) {
      await dataLakeHealthSnapshotRepository.upsertSnapshot(snapshotInput({ snapshotDate }));
    }

    const trend = await dataLakeHealthSnapshotRepository.getTrend('lake-1');
    expect(trend).toHaveLength(90);
  });
});
