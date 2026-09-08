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

// Deliberately NOT mocking the error classes: the real BadRequestError carries statusCode
// 400, which lets the rejection test assert the status the client would actually receive
// rather than only the message. The previous bare `class BadRequestError extends Error` had
// no statusCode at all, so that assertion was impossible.
import { BadRequestError, HttpStatus } from '@bike4mind/common';

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

// Use the REAL appendSuccessParams so the success_url this route builds is
// actually asserted below - mocking it away is what let the individual path ship
// with an unmarked success redirect in the first place. The origin check is stubbed
// because it reads APP_URL from the environment, but driven per-test rather than pinned
// to `true`: a hard-coded verdict asserts nothing about the rejection path.
const mockIsAllowedCallbackOrigin = vi.fn();
vi.mock('@server/integrations/stripe/callbackUrl', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/stripe/callbackUrl')>();
  return { ...actual, isAllowedCallbackOrigin: (...args: unknown[]) => mockIsAllowedCallbackOrigin(...args) };
});
vi.mock('@server/utils/config', () => ({ Config: { STAGE: 'test' } }));

const mockSessionsCreate = vi.fn();
const mockPricesRetrieve = vi.fn();
const mockCustomersRetrieve = vi.fn();
const mockCreateCustomer = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  CustomerType: { User: 'User' },
  stripe: {
    customers: { retrieve: (...args: unknown[]) => mockCustomersRetrieve(...args) },
    prices: { retrieve: (...args: unknown[]) => mockPricesRetrieve(...args) },
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  },
}));

import handler from '../subscribe';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const CALLBACK_URL = 'https://app.example.com/cb';

function makeReq(priceId: string, callbackUrl = CALLBACK_URL) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = { priceId, callbackUrl };
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
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
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

  it('marks the individual success_url so a completed purchase is distinguishable from a cancel', async () => {
    // The bug this route had: success_url was the bare callbackUrl, so a paying
    // subscriber returned indistinguishably from someone who cancelled - no toast,
    // no cache invalidation, and nothing to report a conversion from. The
    // {CHECKOUT_SESSION_ID} template must stay literal for Stripe to substitute it.
    mockGetSettingsValue.mockResolvedValue(true);
    const { req, res } = makeReq('price_open');

    await (handler as HandlerFn)(req, res);

    const args = mockSessionsCreate.mock.calls[0][0] as { success_url: string; cancel_url: string };
    expect(args.success_url).toBe(
      'https://app.example.com/cb?subscription_success=true&checkout_session_id={CHECKOUT_SESSION_ID}'
    );
    expect(args.success_url).not.toContain('%7B');
    // cancel_url stays bare - a cancel must not look like a success.
    expect(args.cancel_url).toBe('https://app.example.com/cb');
    expect(res.statusCode).toBe(200);
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

describe('POST /api/subscriptions/subscribe - callbackUrl origin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAllowedCallbackOrigin.mockReturnValue(true);
    mockGetSettingsValue.mockResolvedValue(true);
    mockFindUserSubByPrice.mockResolvedValue(null);
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_existing' });
    mockPricesRetrieve.mockResolvedValue({ id: 'price_open', active: true });
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe/session' });
  });

  it('rejects a callbackUrl on a disallowed origin with a 400', async () => {
    // The guard is the only thing between a caller-supplied callbackUrl and an open redirect
    // off Stripe's hosted checkout page, where the redirect wears Stripe's brand.
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('price_open', 'https://attacker.example.net/phish');

    // Asserted in ONE throw: message and status together, so the handler runs once. Invoking
    // it twice would double every mock's call log for the assertions below.
    // `constructor:` rather than `toBeInstanceOf` is deliberate - it pins the exact class,
    // where toBeInstanceOf would also accept a SUBCLASS of BadRequestError carrying a
    // different status. Do not "simplify" it.
    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'callbackUrl must point to the deployed application origin',
    });

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith('https://attacker.example.net/phish');
  });

  it('runs the guard before the availability gate, any lookup, or any Stripe side effect', async () => {
    // Ordering matters beyond tidiness: the guard sits above an admin-settings read and a
    // subscription lookup, so a rejected callbackUrl must cost neither.
    mockIsAllowedCallbackOrigin.mockReturnValue(false);
    const { req, res } = makeReq('price_gated', 'https://attacker.example.net/phish');

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow();

    expect(mockGetSettingsValue).not.toHaveBeenCalled();
    expect(mockFindUserSubByPrice).not.toHaveBeenCalled();
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPricesRetrieve).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('passes an allowed-origin callbackUrl through to the checkout session', async () => {
    // Pins the guard as the ONLY reason the two tests above stop early: same fixtures, allowed
    // origin, and execution reaches Stripe. Without this, `not.toHaveBeenCalled()` could pass
    // for the wrong reason.
    const { req, res } = makeReq('price_open');

    await (handler as HandlerFn)(req, res);

    expect(mockIsAllowedCallbackOrigin).toHaveBeenCalledWith(CALLBACK_URL);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
