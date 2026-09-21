// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi: unwrap the chain so handler.put(fn) just returns fn, and .use() is a no-op.
// The options are recorded on `state` rather than left to the call history, because
// the handler is built once at import and `clearAllMocks` erases that call.
const baseApiMock = vi.hoisted(() => {
  const state: { options?: unknown } = {};
  const fn = vi.fn((options?: unknown) => {
    state.options = options;
    return {
      use: function () {
        return this;
      },
      put: (handler: unknown) => handler,
    };
  });
  return { fn, state };
});

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: baseApiMock.fn,
}));

vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Real error classes: BadRequestError carries statusCode 400, so the rejection tests
// assert the status the client receives, not only the message.
import { BadRequestError, HttpStatus } from '@bike4mind/common';
import { SubscriptionPlanInterval, UserSubscriptionTier } from '@client/lib/userSubscriptions/types';
import Stripe from 'stripe';

const mockFindChangeable = vi.fn();
const mockFindActive = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findChangeableUserSubscription: (...args: unknown[]) => mockFindChangeable(...args),
    findActiveUserSubscriptions: (...args: unknown[]) => mockFindActive(...args),
  },
}));

const mockRetrieve = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieve(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

/** Plan ladder fixture: two Basic rungs at the same price, one Pro, one Pro yearly. */
const PLANS: Record<string, { interval: SubscriptionPlanInterval; tier?: UserSubscriptionTier }> = {
  price_basic: { interval: SubscriptionPlanInterval.Monthly, tier: UserSubscriptionTier.Basic },
  price_basic_2: { interval: SubscriptionPlanInterval.Monthly, tier: UserSubscriptionTier.Basic },
  price_pro: { interval: SubscriptionPlanInterval.Monthly, tier: UserSubscriptionTier.Pro },
  price_pro_yearly: { interval: SubscriptionPlanInterval.Yearly, tier: UserSubscriptionTier.Pro },
  price_standalone: { interval: SubscriptionPlanInterval.Monthly },
};

const mockGetPlanByPriceId = vi.fn();
vi.mock('@client/lib/userSubscriptions/utils', () => ({
  getSubscriptionPlanByPriceId: (...args: unknown[]) => mockGetPlanByPriceId(...args),
}));

import handler from '../change';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const CALLBACK_URL = 'https://app.example.com/billing';

/** A changeable Stripe-managed row, with any field overridable per test. */
const subscriptionRow = (overrides: Record<string, unknown> = {}) => ({
  ownerType: 'User',
  ownerId: 'user_1',
  priceId: 'price_basic',
  status: 'active',
  source: 'stripe',
  subscriptionId: 'sub_1',
  ...overrides,
});

function makeReq(priceId = 'price_basic_2') {
  const { req, res } = createMocks({ method: 'PUT' });
  (req as Record<string, unknown>).body = { priceId, callbackUrl: CALLBACK_URL };
  (req as Record<string, unknown>).user = { id: 'user_1' };
  return { req, res };
}

describe('PUT /api/subscriptions/change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindChangeable.mockResolvedValue(subscriptionRow());
    mockGetPlanByPriceId.mockImplementation((priceId: string) =>
      PLANS[priceId]
        ? { priceId, name: priceId, credits: 1, features: [], description: '', ...PLANS[priceId] }
        : undefined
    );
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [{ id: 'si_1' }] } });
    mockUpdate.mockResolvedValue({ id: 'sub_1' });
  });

  it('is jwtOnly, so a leaked API key cannot mutate a live Stripe subscription', () => {
    // ApiKeyScope has no billing scope to gate a key on, so this flag is the only
    // thing between any valid key and a live subscription's price.
    expect(baseApiMock.state.options).toEqual({ auth: 'jwtOnly' });
  });

  it('does not send an admin-grant sentinel to Stripe', async () => {
    // The route used to resolve through findActiveUserSubscriptions, whose blind
    // find matched the grant (it is written status: 'active'), then handed its
    // synthetic id to Stripe. The sentinel is truthy, so the old
    // `!subscriptionId` guard waved it through.
    mockFindChangeable.mockResolvedValue(subscriptionRow({ source: 'admin_grant', subscriptionId: 'admin_grant_abc' }));
    const { req, res } = makeReq('price_pro');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'This subscription is not managed by Stripe and cannot be changed here',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a legacy admin-granted row that never got a source field', async () => {
    // resolveSubscriptionSource is the repo's defensive default for pre-source rows.
    mockFindChangeable.mockResolvedValue(
      subscriptionRow({ source: undefined, subscriptionId: 'admin_granted_legacy' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('is a 400 when there is no changeable subscription', async () => {
    // Covers the terminal-only caller too: the lookup never returns a row the
    // route could not act on.
    mockFindChangeable.mockResolvedValue(null);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'User does not have an active subscription',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('is a 400 when the target price is already the subscriber price', async () => {
    mockFindChangeable.mockResolvedValue(subscriptionRow({ priceId: 'price_basic' }));
    const { req, res } = makeReq('price_basic');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'User is already subscribed to this plan',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('rejects an unknown plan before calling Stripe', async () => {
    const { req, res } = makeReq('price_unknown');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Invalid subscription plan',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('rejects a plan with no tier before calling Stripe', async () => {
    // A standalone product is not a rung on the B4M ladder, so a same-tier swap
    // against it is not a legal change.
    const { req, res } = makeReq('price_standalone');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'This plan cannot be changed here',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it.each(['trialing', 'past_due', 'unpaid', 'paused', 'incomplete'] as const)(
    'changes the plan of a %s row, which the active-only lookup hid',
    async status => {
      mockFindChangeable.mockResolvedValue(subscriptionRow({ status }));
      const { req, res } = makeReq();

      await (handler as HandlerFn)(req, res);

      expect(mockFindChangeable).toHaveBeenCalledWith('user_1');
      // The old lookup is gone: an active-only query is the defect being fixed.
      expect(mockFindActive).not.toHaveBeenCalled();
      expect(mockRetrieve).toHaveBeenCalledWith('sub_1');
      expect(mockUpdate).toHaveBeenCalledWith('sub_1', {
        items: [{ id: 'si_1', price: 'price_basic_2' }],
        proration_behavior: 'none',
      });
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({ subscriptionId: 'sub_1', priceId: 'price_basic_2' });
    }
  );

  it('upgrades across tiers with prorations and a new billing anchor', async () => {
    mockFindChangeable.mockResolvedValue(subscriptionRow({ priceId: 'price_basic' }));
    const { req, res } = makeReq('price_pro');

    await (handler as HandlerFn)(req, res);

    expect(mockUpdate).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_1', price: 'price_pro' }],
      proration_behavior: 'create_prorations',
      billing_cycle_anchor: 'now',
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an annual-to-monthly change without updating Stripe', async () => {
    mockFindChangeable.mockResolvedValue(subscriptionRow({ priceId: 'price_pro_yearly' }));
    const { req, res } = makeReq('price_pro');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Changing from Annual plan to Monthly plan is not allowed',
    });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a downgrade without updating Stripe', async () => {
    mockFindChangeable.mockResolvedValue(subscriptionRow({ priceId: 'price_pro' }));
    const { req, res } = makeReq('price_basic');

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Downgrading subscription is not allowed',
    });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('turns a rejected retrieve into a 400 rather than a 500 that alarms', async () => {
    // StripeError carries statusCode, which the shared error handler does not read.
    mockRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ statusCode: 400, message: 'No such subscription: sub_1' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Stripe rejected the subscription change: No such subscription: sub_1',
    });
  });

  it('turns a rejected update into a 400 rather than a 500 that alarms', async () => {
    mockUpdate.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ statusCode: 400, message: 'No such price: price_basic_2' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Stripe rejected the subscription change: No such price: price_basic_2',
    });
  });

  it.each([
    {
      label: 'a Stripe-side fault',
      makeError: () => new Stripe.errors.StripeAPIError({ statusCode: 500, message: 'Stripe is down' }),
    },
    {
      label: 'a revoked API key (authentication)',
      makeError: () => new Stripe.errors.StripeAuthenticationError({ statusCode: 401, message: 'Invalid API key' }),
    },
    {
      label: 'rate limiting',
      makeError: () => new Stripe.errors.StripeRateLimitError({ statusCode: 429, message: 'Too many requests' }),
    },
  ])('leaves $label as a 5xx so it still trips the alarm', async ({ makeError }) => {
    // None of these is the user's doing. A statusCode threshold cannot tell them
    // from a real rejection, which is why the remap is class-based.
    const stripeFault = makeError();
    mockRetrieve.mockRejectedValue(stripeFault);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toBe(stripeFault);
  });
});
