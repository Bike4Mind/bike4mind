// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi: unwrap the chain so handler.post(fn) just returns fn, and .use() is a no-op.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    post: (fn: unknown) => fn,
  }),
}));

// requireStripeWebhook is applied via .use() (dropped by the baseApi mock); stub the
// factory so importing the handler doesn't touch real webhook config.
vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

const mockGetSettingsValue = vi.fn();
const mockUserUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args) },
  userRepository: { update: (...args: unknown[]) => mockUserUpdate(...args) },
}));

const mockFindUserSubByPrice = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findUserSubscriptionByPriceId: (...args: unknown[]) => mockFindUserSubByPrice(...args) },
}));

// Two plans: one gated behind an availability flag, one always-purchasable.
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [
    {
      priceId: 'price_gated',
      availabilityFlag: 'EnableGatedProduct',
      interval: 'monthly',
      name: 'Gated',
      credits: 1,
      features: [],
      description: '',
    },
    { priceId: 'price_open', interval: 'monthly', name: 'Open', credits: 1, features: [], description: '' },
  ],
}));

vi.mock('@server/integrations/stripe/callbackUrl', () => ({ isAllowedCallbackOrigin: () => true }));
vi.mock('@server/utils/config', () => ({ Config: { STAGE: 'test' } }));

const mockSessionsCreate = vi.fn();
const mockPricesRetrieve = vi.fn();
const mockCustomersRetrieve = vi.fn();
const mockCreateCustomer = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  CustomerType: { User: 'user' },
  stripe: {
    customers: { retrieve: (...args: unknown[]) => mockCustomersRetrieve(...args) },
    prices: { retrieve: (...args: unknown[]) => mockPricesRetrieve(...args) },
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  },
}));

import handler from '../subscribe';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

function makeReq(priceId: string) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = { priceId, callbackUrl: 'https://app.example.com/cb' };
  (req as Record<string, unknown>).user = {
    id: 'user_1',
    email: 'buyer@example.com',
    name: 'Buyer',
    stripeCustomerId: 'cus_existing',
  };
  return { req, res };
}

describe('POST /api/subscriptions/subscribe — launch/availability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserSubByPrice.mockResolvedValue(null); // not already subscribed
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_existing' });
    mockPricesRetrieve.mockResolvedValue({ id: 'price_gated', active: true });
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  it('blocks checkout with a 400 when the plan availability flag is OFF (before any Stripe call)', async () => {
    mockGetSettingsValue.mockResolvedValue(false);
    const { req, res } = makeReq('price_gated');

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('This plan is not available yet');

    expect(mockGetSettingsValue).toHaveBeenCalledWith('EnableGatedProduct');
    expect(mockSessionsCreate).not.toHaveBeenCalled(); // gate runs before the Stripe side effect
  });

  it('allows checkout when the availability flag is ON (gate passes → session created)', async () => {
    mockGetSettingsValue.mockResolvedValue(true);
    const { req, res } = makeReq('price_gated');

    await (handler as HandlerFn)(req, res);

    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res._getData()).toEqual({ sessionUrl: 'https://checkout.stripe/session' });
  });

  it('fails closed when the flag setting resolves to a non-boolean-true value (=== true read)', async () => {
    // e.g. a plan mistakenly pointed at a numeric setting: 5 is truthy but not `true`.
    mockGetSettingsValue.mockResolvedValue(5 as unknown as boolean);
    const { req, res } = makeReq('price_gated');

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('This plan is not available yet');
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('does not gate a plan with no availabilityFlag (setting never read, checkout proceeds)', async () => {
    const { req, res } = makeReq('price_open');

    await (handler as HandlerFn)(req, res);

    expect(mockGetSettingsValue).not.toHaveBeenCalled();
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
