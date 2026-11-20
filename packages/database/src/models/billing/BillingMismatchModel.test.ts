import { beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { setupMongoTest } from '../../__test__/utils';
import {
  BillingMismatchModel,
  billingMismatchRepository as repo,
  type BillingMismatchFinding,
} from './BillingMismatchModel';

setupMongoTest();

beforeEach(async () => {
  // setupMongoTest drops the database between tests, unique index included.
  await BillingMismatchModel.syncIndexes();
});

const T0 = new Date('2026-11-01T06:30:00Z');
const T1 = new Date('2026-11-02T06:30:00Z');

const finding = (id: string, overrides: Partial<BillingMismatchFinding> = {}): BillingMismatchFinding => ({
  stripeSubscriptionId: id,
  kind: 'drift',
  subscriptionRowId: new mongoose.Types.ObjectId().toString(),
  ownerType: 'User',
  ownerId: 'user_1',
  fields: [{ field: 'quantity', mongo: '1', stripe: '3' }],
  stripeStatus: 'active',
  ...overrides,
});

const statusOf = async (id: string) => (await BillingMismatchModel.findOne({ stripeSubscriptionId: id }).lean())!;

describe('BillingMismatchRepository', () => {
  it('keeps one row per Stripe subscription and the first-seen time while it stays open', async () => {
    expect(await repo.upsertOpen(finding('sub_1'), T0)).toBe(true);
    expect(
      await repo.upsertOpen(
        finding('sub_1', { fields: [{ field: 'status', mongo: 'active', stripe: 'canceled' }] }),
        T1
      )
    ).toBe(false);

    expect(await BillingMismatchModel.countDocuments({ stripeSubscriptionId: 'sub_1' })).toBe(1);
    const row = await statusOf('sub_1');
    expect(row.firstSeenAt).toEqual(T0);
    expect(row.lastSeenAt).toEqual(T1);
    expect(row.fields).toEqual([{ field: 'status', mongo: 'active', stripe: 'canceled' }]);
  });

  it('resolves only covered findings that were not seen again', async () => {
    await repo.upsertOpen(finding('sub_covered'), T0);
    await repo.upsertOpen(finding('sub_seen'), T0);
    await repo.upsertOpen(finding('sub_uncovered'), T0);

    const resolved = await repo.resolveMissing({
      coveredIds: ['sub_covered', 'sub_seen'],
      seenIds: ['sub_seen'],
      completeListing: false,
      now: T1,
    });

    expect(resolved).toBe(1);
    expect(await statusOf('sub_covered')).toMatchObject({
      status: 'resolved',
      resolvedAt: T1,
      resolvedBy: 'reconciliation',
    });
    expect((await statusOf('sub_seen')).status).toBe('open');
    expect((await statusOf('sub_uncovered')).status).toBe('open');
  });

  it('treats an open orphan_stripe as covered only after a complete listing', async () => {
    await repo.upsertOpen(finding('sub_orphan', { kind: 'orphan_stripe', subscriptionRowId: null }), T0);
    const run = (completeListing: boolean) =>
      repo.resolveMissing({ coveredIds: [], seenIds: [], completeListing, now: T1 });

    expect(await run(false)).toBe(0);
    expect(await run(true)).toBe(1);
  });

  it('reopens a resolved finding with a fresh first-seen time', async () => {
    await repo.upsertOpen(finding('sub_1'), T0);
    await repo.resolveMissing({ coveredIds: ['sub_1'], seenIds: [], completeListing: true, now: T0 });
    await repo.upsertOpen(finding('sub_1'), T1);

    expect(await statusOf('sub_1')).toMatchObject({
      status: 'open',
      firstSeenAt: T1,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it('resolves by row id for Sync and reads the open finding back', async () => {
    const rowId = new mongoose.Types.ObjectId().toString();
    await repo.upsertOpen(finding('sub_1', { subscriptionRowId: rowId }), T0);

    expect((await repo.findOpenBySubscriptionRowId(rowId))?.stripeSubscriptionId).toBe('sub_1');
    await repo.resolveForSubscription(rowId, 'sync', T1);
    expect(await repo.findOpenBySubscriptionRowId(rowId)).toBeNull();
    expect(await statusOf('sub_1')).toMatchObject({ status: 'resolved', resolvedBy: 'sync' });
  });

  it('caps the open row ids, counts and lists orphans', async () => {
    await repo.upsertOpen(finding('sub_a'), T0);
    await repo.upsertOpen(finding('sub_b'), T1);
    await repo.upsertOpen(finding('sub_o', { kind: 'orphan_stripe', subscriptionRowId: null }), T1);

    const capped = await repo.openSubscriptionRowIds(1);
    expect(capped.ids).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect((await repo.openSubscriptionRowIds(5)).truncated).toBe(false);
    expect(await repo.openCounts()).toEqual({ open: 3, orphanStripe: 1, lastSeenAt: T1 });
    expect((await repo.listOpenOrphanStripe(20)).map(f => f.stripeSubscriptionId)).toEqual(['sub_o']);
  });
});
