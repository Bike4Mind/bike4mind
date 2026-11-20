import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSettingsValue = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
}));

const mockChargesList = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    charges: {
      list: (...args: unknown[]) => mockChargesList(...args),
    },
  },
}));

import { firstPurchaseCardOptions, isFirstPurchase } from './threeDSecure';

const NOW = new Date('2026-06-15T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_ACCOUNT = new Date(NOW.getTime() - 30 * DAY_MS);
const CHALLENGE = { payment_method_options: { card: { request_three_d_secure: 'challenge' } } };

function charges(...list: Array<{ status: string; disputed?: boolean }>) {
  return { data: list.map(charge => ({ disputed: false, ...charge })) };
}

function settings(values: { enabled?: boolean; newAccountDays?: number }) {
  mockGetSettingsValue.mockImplementation((key: string) => {
    if (key === 'requireThreeDSecureOnFirstPurchase') return Promise.resolve(values.enabled ?? true);
    if (key === 'threeDSecureNewAccountDays') return Promise.resolve(values.newAccountDays ?? 7);
    return Promise.resolve(undefined);
  });
}

const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  settings({});
  mockChargesList.mockResolvedValue(charges());
});

describe('isFirstPurchase', () => {
  const base = { stripeCustomerId: 'cus_1', accountCreatedAt: OLD_ACCOUNT, newAccountDays: 7, now: NOW };

  it('is true for a customer with no succeeded charge', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'failed' }));
    await expect(isFirstPurchase(base)).resolves.toBe(true);
    expect(mockChargesList).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 });
  });

  it('is false once an old account has a succeeded charge', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'failed' }, { status: 'succeeded' }));
    await expect(isFirstPurchase(base)).resolves.toBe(false);
  });

  it('does not count a disputed charge as a prior purchase', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded', disputed: true }));
    await expect(isFirstPurchase(base)).resolves.toBe(true);
  });

  it('is true without a Stripe customer, without asking Stripe', async () => {
    await expect(isFirstPurchase({ ...base, stripeCustomerId: null })).resolves.toBe(true);
    expect(mockChargesList).not.toHaveBeenCalled();
  });

  it('is true inside the new-account window even after a succeeded charge', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded' }));
    const accountCreatedAt = new Date(NOW.getTime() - 6 * DAY_MS);
    await expect(isFirstPurchase({ ...base, accountCreatedAt })).resolves.toBe(true);
    expect(mockChargesList).not.toHaveBeenCalled();
  });

  it('ignores the account age when the window is 0 days', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded' }));
    await expect(isFirstPurchase({ ...base, accountCreatedAt: NOW, newAccountDays: 0 })).resolves.toBe(false);
  });

  it('treats a missing or unparseable creation date as a new account', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded' }));
    await expect(isFirstPurchase({ ...base, accountCreatedAt: undefined })).resolves.toBe(true);
    await expect(isFirstPurchase({ ...base, accountCreatedAt: 'not a date' })).resolves.toBe(true);
  });
});

describe('firstPurchaseCardOptions', () => {
  const input = { stripeCustomerId: 'cus_1', accountCreatedAt: OLD_ACCOUNT };

  it('requests a 3-D Secure challenge on a first purchase', async () => {
    await expect(firstPurchaseCardOptions(input, logger)).resolves.toEqual(CHALLENGE);
  });

  it('requests nothing after a prior succeeded purchase', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded' }));
    await expect(firstPurchaseCardOptions(input, logger)).resolves.toEqual({});
  });

  it('never requests 3-D Secure when the setting is off', async () => {
    settings({ enabled: false });
    await expect(firstPurchaseCardOptions({ stripeCustomerId: null, accountCreatedAt: NOW }, logger)).resolves.toEqual(
      {}
    );
    expect(mockChargesList).not.toHaveBeenCalled();
  });

  it('applies the admin-configured new-account window', async () => {
    mockChargesList.mockResolvedValue(charges({ status: 'succeeded' }));
    const tenDaysOld = { ...input, accountCreatedAt: new Date(NOW.getTime() - 10 * DAY_MS) };

    settings({ newAccountDays: 7 });
    await expect(firstPurchaseCardOptions(tenDaysOld, logger)).resolves.toEqual({});

    settings({ newAccountDays: 14 });
    await expect(firstPurchaseCardOptions(tenDaysOld, logger)).resolves.toEqual(CHALLENGE);
  });

  it('fails closed and logs when Stripe cannot list charges', async () => {
    mockChargesList.mockRejectedValue(new Error('stripe down'));
    await expect(firstPurchaseCardOptions(input, logger)).resolves.toEqual(CHALLENGE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[ThreeDSecure]'),
      expect.objectContaining({ stripeCustomerId: 'cus_1', error: 'stripe down' })
    );
  });
});
