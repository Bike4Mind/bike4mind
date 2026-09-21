import { describe, it, expect, beforeEach } from 'vitest';
import { DataLakeHealthSnapshotModel, dataLakeHealthSnapshotRepository } from './DataLakeHealthSnapshotModel';
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
});
