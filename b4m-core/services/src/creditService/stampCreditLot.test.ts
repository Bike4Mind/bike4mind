import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stampCreditLot, StampCreditLotAdapters } from './stampCreditLot';
import { CreditHolderType } from '@bike4mind/common';

describe('creditService - stampCreditLot', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let adapters: StampCreditLotAdapters;
  const now = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    mockCreate = vi.fn().mockResolvedValue({ id: 'lot1' });
    adapters = { db: { creditLots: { create: mockCreate } as any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('stamps a 12-month pack lot for a purchase grant, carrying the Stripe ref', async () => {
    await stampCreditLot(
      {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        amount: 500,
        grantType: 'purchase',
        stripeRef: 'pi_123',
        now,
      },
      adapters
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        source: 'pack',
        amount: 500,
        consumedAssigned: 0,
        stripeRef: 'pi_123',
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      })
    );
  });

  it('stamps a 90-day subscription lot for a subscription grant', async () => {
    await stampCreditLot(
      { ownerId: 'org1', ownerType: CreditHolderType.Organization, amount: 300, grantType: 'subscription', now },
      adapters
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'subscription', expiresAt: new Date('2026-04-01T00:00:00.000Z') })
    );
  });

  it('stamps a 90-day promo lot for a generic_add grant', async () => {
    await stampCreditLot(
      { ownerId: 'user1', ownerType: CreditHolderType.User, amount: 50, grantType: 'generic_add', now },
      adapters
    );

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'promo' }));
  });

  it('stamps a 90-day transfer lot for a received_credit grant', async () => {
    await stampCreditLot(
      { ownerId: 'agent1', ownerType: CreditHolderType.Agent, amount: 20, grantType: 'received_credit', now },
      adapters
    );

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ source: 'transfer' }));
  });

  it('stamps a 12-month legacy lot for the migration backfill grant type', async () => {
    await stampCreditLot(
      { ownerId: 'user1', ownerType: CreditHolderType.User, amount: 1000, grantType: 'legacy', now },
      adapters
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'legacy', expiresAt: new Date('2027-01-01T00:00:00.000Z') })
    );
  });

  it('is best-effort: swallows a create failure instead of throwing', async () => {
    mockCreate.mockRejectedValue(new Error('DB unavailable'));

    await expect(
      stampCreditLot(
        { ownerId: 'user1', ownerType: CreditHolderType.User, amount: 100, grantType: 'generic_add', now },
        adapters
      )
    ).resolves.toBeUndefined();
  });

  it('defaults `now` to the current time when omitted', async () => {
    await stampCreditLot(
      { ownerId: 'user1', ownerType: CreditHolderType.User, amount: 100, grantType: 'generic_add' },
      adapters
    );

    expect(mockCreate).toHaveBeenCalled();
  });
});
