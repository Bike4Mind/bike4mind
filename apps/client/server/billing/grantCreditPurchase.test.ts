import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWithTransaction = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

const mockStampCreditLot = vi.fn();
vi.mock('@bike4mind/services', () => ({
  creditService: {
    addCredits: vi.fn(),
    stampCreditLot: (...args: unknown[]) => mockStampCreditLot(...args),
  },
}));

import { grantCreditPurchase } from './grantCreditPurchase';

const grant = { userId: 'user_1', paymentIntentId: 'pi_1', credits: 500, amount: 999 };
const duplicateOn = (keyPattern: Record<string, number>) =>
  Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

// The transactional paths run against a real replica set in grantCreditPurchase.e2e.test.ts;
// these pin how errors escaping the transaction are classified.
describe('grantCreditPurchase error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats a duplicate on the payment intent as already granted', async () => {
    mockWithTransaction.mockRejectedValue(duplicateOn({ stripePaymentIntentId: 1 }));

    await expect(grantCreditPurchase(grant)).resolves.toBe('already_granted');
    expect(mockStampCreditLot).not.toHaveBeenCalled();
  });

  it('rethrows a duplicate on any other key', async () => {
    mockWithTransaction.mockRejectedValue(duplicateOn({ transactionId: 1 }));

    await expect(grantCreditPurchase(grant)).rejects.toMatchObject({ code: 11000 });
  });

  it('rethrows any other error', async () => {
    mockWithTransaction.mockRejectedValue(new Error('balance write failed'));

    await expect(grantCreditPurchase(grant)).rejects.toThrow('balance write failed');
  });
});
