import { describe, it, expect } from 'vitest';
import { CreditLot, creditLotRepository } from './CreditLotModel';
import { setupMongoTest } from '../../__test__/utils';
import { CreditHolderType } from '@bike4mind/common';

function makeLot(overrides: Partial<Parameters<typeof creditLotRepository.create>[0]> = {}) {
  return {
    ownerId: 'user1',
    ownerType: CreditHolderType.User,
    source: 'pack' as const,
    amount: 100,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    consumedAssigned: 0,
    ...overrides,
  };
}

describe('CreditLotModel', () => {
  setupMongoTest();

  it('creates a lot with the expected fields and default consumedAssigned', async () => {
    const lot = await creditLotRepository.create(makeLot({ consumedAssigned: undefined as unknown as number }));

    expect(lot.ownerId).toBe('user1');
    expect(lot.ownerType).toBe(CreditHolderType.User);
    expect(lot.source).toBe('pack');
    expect(lot.amount).toBe(100);
    expect(lot.consumedAssigned).toBe(0);
    expect(lot.id).toBeTruthy();
  });

  it('findByOwner returns only lots for that owner, sorted soonest-expiry-first', async () => {
    await creditLotRepository.create(makeLot({ expiresAt: new Date('2027-06-01T00:00:00.000Z') }));
    await creditLotRepository.create(makeLot({ expiresAt: new Date('2027-01-01T00:00:00.000Z') }));
    await creditLotRepository.create(makeLot({ expiresAt: new Date('2027-03-01T00:00:00.000Z') }));
    await creditLotRepository.create(makeLot({ ownerId: 'other-user' }));

    const lots = await creditLotRepository.findByOwner('user1', CreditHolderType.User);

    expect(lots).toHaveLength(3);
    expect(lots.map(l => l.expiresAt.toISOString())).toEqual([
      new Date('2027-01-01T00:00:00.000Z').toISOString(),
      new Date('2027-03-01T00:00:00.000Z').toISOString(),
      new Date('2027-06-01T00:00:00.000Z').toISOString(),
    ]);
  });

  it('findByStripeRef returns lots matching the Stripe payment intent id', async () => {
    await creditLotRepository.create(makeLot({ stripeRef: 'pi_abc' }));
    await creditLotRepository.create(makeLot({ stripeRef: 'pi_other' }));

    const lots = await creditLotRepository.findByStripeRef('pi_abc');

    expect(lots).toHaveLength(1);
    expect(lots[0].stripeRef).toBe('pi_abc');
  });

  it('rejects an unknown source value', async () => {
    await expect(
      CreditLot.create({
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        source: 'not-a-real-source' as 'pack',
        amount: 100,
        expiresAt: new Date(),
      })
    ).rejects.toThrow();
  });

  it('update mutates consumedAssigned via BaseRepository.update', async () => {
    const lot = await creditLotRepository.create(makeLot());

    const updated = await creditLotRepository.update({ id: lot.id, consumedAssigned: 40 });

    expect(updated?.consumedAssigned).toBe(40);
    expect(updated?.amount).toBe(100); // untouched
  });
});
