import { beforeEach, describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { RevenueSnapshotModel, revenueSnapshotRepository, type RevenueSnapshotInput } from './RevenueSnapshotModel';

setupMongoTest();

beforeEach(async () => {
  // setupMongoTest drops the database between tests, unique index included; rebuild it so the upsert
  // runs against the real constraint.
  await RevenueSnapshotModel.syncIndexes();
});

const zero = { amount: 0, unpriced: 0, otherCurrency: 0 };

const snapshot = (overrides: Partial<RevenueSnapshotInput> = {}): RevenueSnapshotInput => ({
  snapshotDate: '2026-10-01',
  computedAt: new Date('2026-10-02T00:15:00Z'),
  currency: 'usd',
  mrr: { amount: 4900, unpriced: 1, otherCurrency: 0 },
  payingCount: 3,
  mrrByPlan: [{ priceId: 'price_pro', count: 3, amount: 4900, unpriced: 1, otherCurrency: 0 }],
  mrrByOwnerType: [{ ownerType: 'User', count: 3, amount: 4900, unpriced: 1, otherCurrency: 0 }],
  newMrr: { amount: 1900, unpriced: 0, otherCurrency: 0 },
  churnedMrr: zero,
  pastDueMrr: zero,
  cancelingMrr: zero,
  ...overrides,
});

describe('RevenueSnapshotRepository', () => {
  it('writes one row per day and replaces it on a rerun', async () => {
    await revenueSnapshotRepository.upsertSnapshot(snapshot());
    await revenueSnapshotRepository.upsertSnapshot(
      snapshot({ mrr: { amount: 5900, unpriced: 0, otherCurrency: 0 }, payingCount: 4 })
    );

    const rows = await RevenueSnapshotModel.find({ snapshotDate: '2026-10-01' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].mrr).toEqual({ amount: 5900, unpriced: 0, otherCurrency: 0 });
    expect(rows[0].payingCount).toBe(4);
    expect(rows[0].mrrByPlan).toEqual([
      { priceId: 'price_pro', count: 3, amount: 4900, unpriced: 1, otherCurrency: 0 },
    ]);
  });

  it('rejects a snapshot date that is not a UTC day', async () => {
    await expect(revenueSnapshotRepository.upsertSnapshot(snapshot({ snapshotDate: '2026-10-1' }))).rejects.toThrow();
  });

  it('reads a range of days oldest first, bounds included', async () => {
    for (const day of ['2026-10-03', '2026-09-30', '2026-10-01', '2026-10-02']) {
      await revenueSnapshotRepository.upsertSnapshot(snapshot({ snapshotDate: day }));
    }
    const rows = await revenueSnapshotRepository.findRange('2026-10-01', '2026-10-02');
    expect(rows.map(row => row.snapshotDate)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('reports the first snapshot day, or null before any exists', async () => {
    expect(await revenueSnapshotRepository.firstSnapshotDate()).toBeNull();
    await revenueSnapshotRepository.upsertSnapshot(snapshot({ snapshotDate: '2026-10-05' }));
    await revenueSnapshotRepository.upsertSnapshot(snapshot({ snapshotDate: '2026-10-04' }));
    expect(await revenueSnapshotRepository.firstSnapshotDate()).toBe('2026-10-04');
  });
});
