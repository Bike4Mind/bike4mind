import { describe, it, expect } from 'vitest';
import { CreditHolderType, type CreditHoldRecord } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { PendingCreditHoldModel, pendingCreditHoldRepository } from './PendingCreditHoldModel';

const hold: CreditHoldRecord = {
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits: 5,
  balanceAfterHold: 95,
};
const now = new Date('2026-10-19T12:00:00.000Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

describe('PendingCreditHoldModel', () => {
  setupMongoTest();

  it('expires only completed receipts, never outstanding money', () => {
    const ttlIndexes = PendingCreditHoldModel.schema
      .indexes()
      .filter(([, options]) => options.expireAfterSeconds !== undefined);
    expect(ttlIndexes).toHaveLength(1);
    expect(ttlIndexes[0]?.[0]).toEqual({ settledAt: 1 });
    expect(ttlIndexes[0]?.[1].expireAfterSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('round-trips the hold record', async () => {
    const recorded = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(60));

    expect(recorded).toEqual({ ...hold, id: expect.any(String), featureLabel: 'embeddings', expiresAt: minutes(60) });
  });

  it('lets exactly one caller claim a hold', async () => {
    const { id } = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(60));

    const [first, second] = await Promise.all([
      pendingCreditHoldRepository.claim(id),
      pendingCreditHoldRepository.claim(id),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await pendingCreditHoldRepository.claimExpired(id, minutes(120))).toBeNull();
  });

  it('claims an unexpired hold only through claim, not claimExpired', async () => {
    const { id } = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(60));

    expect(await pendingCreditHoldRepository.claimExpired(id, now)).toBeNull();
    expect(await pendingCreditHoldRepository.claimExpired(id, minutes(60))).toMatchObject({ id });
  });

  it('finds only expired holds, oldest first, up to the limit', async () => {
    const late = await pendingCreditHoldRepository.record(hold, 'b', minutes(-5));
    const early = await pendingCreditHoldRepository.record(hold, 'a', minutes(-30));
    await pendingCreditHoldRepository.record(hold, 'c', minutes(-1));
    await pendingCreditHoldRepository.record(hold, 'live', minutes(10));

    const expired = await pendingCreditHoldRepository.findExpired(now, 2);

    expect(expired.map(h => h.id)).toEqual([early.id, late.id]);
  });
  it('retains a settlement receipt and excludes it from every refund path', async () => {
    const recorded = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(-5));

    expect(await pendingCreditHoldRepository.markSettled(recorded.id, 0)).toBe(true);
    expect(await pendingCreditHoldRepository.findSettlement(recorded.id)).toBe(0);
    expect(await pendingCreditHoldRepository.markSettled(recorded.id, 5)).toBe(false);
    expect(await pendingCreditHoldRepository.claim(recorded.id)).toBeNull();
    expect(await pendingCreditHoldRepository.claimExpired(recorded.id, now)).toBeNull();
    expect(await pendingCreditHoldRepository.findExpired(now, 10)).toEqual([]);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(1);
  });

  it('cannot settle an already refunded hold', async () => {
    const { id } = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(-5));
    await pendingCreditHoldRepository.claim(id);

    expect(await pendingCreditHoldRepository.markSettled(id, 3)).toBe(false);
    expect(await pendingCreditHoldRepository.findSettlement(id)).toBeNull();
  });

  it('allows only one concurrent settlement to write the receipt', async () => {
    const { id } = await pendingCreditHoldRepository.record(hold, 'embeddings', minutes(60));
    const results = await Promise.all([
      pendingCreditHoldRepository.markSettled(id, 2),
      pendingCreditHoldRepository.markSettled(id, 3),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await pendingCreditHoldRepository.findSettlement(id)).toBe(results[0] ? 2 : 3);
  });
});
