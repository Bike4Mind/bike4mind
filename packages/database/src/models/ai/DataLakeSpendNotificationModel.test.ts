import { describe, it, expect, beforeEach } from 'vitest';
import type { ClaimSpendNotificationInput } from '@bike4mind/common';
import {
  dataLakeSpendNotificationRepository as repo,
  DataLakeSpendNotificationModel,
} from './DataLakeSpendNotificationModel';
import { setupMongoTest } from '../../__test__/utils';

const claimInput = (overrides: Partial<ClaimSpendNotificationInput> = {}): ClaimSpendNotificationInput => ({
  dataLakeId: 'lake-1',
  kind: 'budget_exhausted',
  scope: 'lake',
  periodKey: 'lake:100000000',
  detail: { spentMicroUsd: 5_000_000, budgetMicroUsd: 5_000_000 },
  ...overrides,
});

describe('DataLakeSpendNotificationRepository', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included), and this model is not in its
  // one-time ensureIndexes list - rebuild the unique index per test so the collision case is real.
  beforeEach(async () => {
    await DataLakeSpendNotificationModel.ensureIndexes();
  });

  it('a single claim wins and creates one row', async () => {
    const result = await repo.claimNotification(claimInput());

    expect(result.claimed).toBe(true);
    expect(result.id).toBeDefined();
    const docs = await DataLakeSpendNotificationModel.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].expiresAt).toBeInstanceOf(Date);
  });

  it('a second claim on the same (dataLakeId, kind, scope, periodKey) key is deduped', async () => {
    const first = await repo.claimNotification(claimInput());
    const second = await repo.claimNotification(claimInput());

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.id).toBeUndefined();
    const docs = await DataLakeSpendNotificationModel.find({});
    expect(docs).toHaveLength(1);
  });

  it('8 concurrent claims on the same key yield exactly one winner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.claimNotification(claimInput())));

    expect(results.filter(r => r.claimed)).toHaveLength(1);
    const docs = await DataLakeSpendNotificationModel.find({});
    expect(docs).toHaveLength(1);
  });

  it('a different periodKey claims a fresh row', async () => {
    const first = await repo.claimNotification(claimInput({ periodKey: 'lake:100000000' }));
    const second = await repo.claimNotification(claimInput({ periodKey: 'lake:150000000' }));

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
    const docs = await DataLakeSpendNotificationModel.find({});
    expect(docs).toHaveLength(2);
  });

  it('a different kind or scope also claims a fresh row (each axis is part of the key)', async () => {
    const first = await repo.claimNotification(claimInput({ kind: 'budget_exhausted', scope: 'lake' }));
    const second = await repo.claimNotification(claimInput({ kind: 'approaching_cap', scope: 'lake' }));
    const third = await repo.claimNotification(claimInput({ kind: 'approaching_cap', scope: 'period' }));

    expect([first, second, third].every(r => r.claimed)).toBe(true);
  });

  it('markDelivered records the outcome against the claimed row', async () => {
    const claim = await repo.claimNotification(claimInput());
    await repo.markDelivered(claim.id!, { recipientUserIds: ['u1', 'u2'], deliveredCount: 2, deliveryFailed: false });

    const doc = await DataLakeSpendNotificationModel.findById(claim.id);
    expect(doc?.recipientUserIds).toEqual(['u1', 'u2']);
    expect(doc?.recipientCount).toBe(2);
    expect(doc?.deliveredCount).toBe(2);
    expect(doc?.deliveryFailed).toBe(false);
  });

  it('deleteForLake re-arms - a subsequent claim on the same key succeeds again', async () => {
    await repo.claimNotification(claimInput());
    const deletedCount = await repo.deleteForLake('lake-1');
    expect(deletedCount).toBe(1);

    const reclaim = await repo.claimNotification(claimInput());
    expect(reclaim.claimed).toBe(true);
  });

  it('deleteForLake never touches another lake', async () => {
    await repo.claimNotification(claimInput({ dataLakeId: 'lake-1' }));
    await repo.claimNotification(claimInput({ dataLakeId: 'lake-2' }));

    await repo.deleteForLake('lake-1');

    const remaining = await DataLakeSpendNotificationModel.find({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].dataLakeId).toBe('lake-2');
  });

  it('listRecentForLake returns newest first, scoped to the lake', async () => {
    await repo.claimNotification(claimInput({ dataLakeId: 'lake-1', scope: 'lake', periodKey: 'a' }));
    await new Promise(r => setTimeout(r, 5));
    await repo.claimNotification(claimInput({ dataLakeId: 'lake-1', scope: 'period', periodKey: 'b' }));
    await repo.claimNotification(claimInput({ dataLakeId: 'lake-2', scope: 'lake', periodKey: 'c' }));

    const recent = await repo.listRecentForLake('lake-1');
    expect(recent).toHaveLength(2);
    expect(recent.every(d => d.dataLakeId === 'lake-1')).toBe(true);
    expect(recent[0].periodKey).toBe('b');
  });
});
