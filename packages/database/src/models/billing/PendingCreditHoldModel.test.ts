import { describe, it, expect } from 'vitest';
import { CreditHolderType, type CreditHoldRecord } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { pendingCreditHoldRepository } from './PendingCreditHoldModel';

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
});
