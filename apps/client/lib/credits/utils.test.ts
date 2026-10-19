// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MIN_PRICE_PER_CREDIT_USD } from '@bike4mind/common';
import { TransactionType } from './types';

let storedSettings: Record<string, unknown> = {};
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: () => Promise.resolve(storedSettings),
}));

import { handlePerCreditTransaction } from './utils';

const logger = { error: vi.fn() };
const buy = (credits: number) =>
  handlePerCreditTransaction({ transactionType: TransactionType.PerCredit, credits }, { userId: 'user_1', logger });

describe('handlePerCreditTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedSettings = { pricePerCredit: String(MIN_PRICE_PER_CREDIT_USD) };
  });

  it('never charges less than the floor price for the credits sold', async () => {
    // Sweeps counts whose exact price is a fraction of a cent, where rounding to the nearest cent
    // would round down.
    for (let credits = 1000; credits <= 1200; credits++) {
      const { amount } = await buy(credits);
      expect(amount + 1e-6).toBeGreaterThanOrEqual(MIN_PRICE_PER_CREDIT_USD * credits * 100);
    }
  });

  it('charges a whole number of cents', async () => {
    storedSettings = { pricePerCredit: '0.0123' };
    for (const credits of [41, 77, 1001, 12345]) {
      const { amount } = await buy(credits);
      expect(Number.isInteger(amount)).toBe(true);
    }
  });

  it('does not add a cent when the exact price is already whole', async () => {
    // 0.0006 * 1000 * 100 is 60.00000000000001 in floating point.
    storedSettings = { pricePerCredit: '0.0006' };
    expect((await buy(1000)).amount).toBe(60);
  });

  it('refuses a per-credit purchase when the configured price is below the floor', async () => {
    storedSettings = { pricePerCredit: String(MIN_PRICE_PER_CREDIT_USD / 2) };

    await expect(buy(100_000)).rejects.toMatchObject({ statusCode: 500 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('below the floor'), { userId: 'user_1' });
  });

  it('refuses a purchase that totals less than the card minimum', async () => {
    storedSettings = { pricePerCredit: '0.01' };

    await expect(buy(49)).rejects.toThrow(/at least 50 credits/);
    expect((await buy(50)).amount).toBe(50);
  });
});
