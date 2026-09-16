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

vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Real error classes: BadRequestError carries statusCode 400, so the rejection
// tests assert the status the client receives, not only the message.
import { BadRequestError, HttpStatus } from '@bike4mind/common';
import Stripe from 'stripe';

const mockFindCancelable = vi.fn();
const mockFindActive = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findCancelableUserSubscriptionByPriceId: (...args: unknown[]) => mockFindCancelable(...args),
    findActiveUserSubscriptions: (...args: unknown[]) => mockFindActive(...args),
  },
}));

const mockRetrieve = vi.fn();
const mockCancel = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieve(...args),
      cancel: (...args: unknown[]) => mockCancel(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

const mockVoidOpenSubscriptionInvoices = vi.fn();
vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: (...args: unknown[]) => mockVoidOpenSubscriptionInvoices(...args),
}));

import handler from '../cancel';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** A cancellable Stripe-managed row, with any field overridable per test. */
const subscriptionRow = (overrides: Record<string, unknown> = {}) => ({
  ownerType: 'User',
  ownerId: 'user_1',
  priceId: 'price_pro',
  status: 'past_due',
  source: 'stripe',
  subscriptionId: 'sub_1',
  ...overrides,
});

function makeReq(priceId = 'price_pro') {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = { priceId };
  (req as Record<string, unknown>).user = { id: 'user_1', stripeCustomerId: 'cus_1' };
  (req as Record<string, unknown>).logger = logger;
  return { req, res };
}

describe('POST /api/subscriptions/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoidOpenSubscriptionInvoices.mockResolvedValue({ voided: [], failed: [] });
  });

  it.each(['past_due', 'unpaid', 'incomplete'] as const)(
    'cancels immediately and voids open invoices when Stripe reports %s',
    async liveStatus => {
      // The repro's starting point: a delinquent row. The old lookup filtered
      // status: 'active', so this request 400'd before it ever reached Stripe.
      // 'unpaid' is where Stripe's dunning cycle lands, so it must not silently
      // fall back to cancel_at_period_end.
      mockFindCancelable.mockResolvedValue(subscriptionRow({ status: liveStatus }));
      mockRetrieve.mockResolvedValue({ id: 'sub_1', status: liveStatus });
      mockCancel.mockResolvedValue({ id: 'sub_1', canceled_at: 1700000000 });
      mockVoidOpenSubscriptionInvoices.mockResolvedValue({ voided: ['in_1'], failed: [] });
      const { req, res } = makeReq();

      await (handler as HandlerFn)(req, res);

      expect(mockFindCancelable).toHaveBeenCalledWith('price_pro', 'user_1');
      expect(mockFindActive).not.toHaveBeenCalled();
      expect(mockCancel).toHaveBeenCalledWith('sub_1');
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockVoidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_1');
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({ priceId: 'price_pro', canceledAt: '2023-11-14T22:13:20.000Z' });
    }
  );

  it('cancels at period end and still voids when the subscription is in good standing', async () => {
    mockFindCancelable.mockResolvedValue(subscriptionRow({ status: 'active' }));
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });
    mockUpdate.mockResolvedValue({ id: 'sub_1', canceled_at: 1700000000 });
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockVoidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_1');
    expect(res.statusCode).toBe(200);
  });

  it('trusts Stripe over a stale local status when choosing the branch', async () => {
    // Webhook lag can leave the row reading 'active' while Stripe already dunned.
    mockFindCancelable.mockResolvedValue(subscriptionRow({ status: 'active' }));
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'past_due' });
    mockCancel.mockResolvedValue({ id: 'sub_1', canceled_at: 1700000000 });
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockCancel).toHaveBeenCalledWith('sub_1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('is an idempotent success when Stripe already terminated the subscription', async () => {
    // Reachable when our webhook lags Stripe's own dunning auto-cancel. Update on a
    // terminal subscription is rejected by Stripe, so reporting 500 here would alarm
    // on a user whose intent is already satisfied.
    mockFindCancelable.mockResolvedValue(subscriptionRow({ status: 'past_due' }));
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled', canceled_at: 1700000000 });
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockVoidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_1');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ priceId: 'price_pro', canceledAt: '2023-11-14T22:13:20.000Z' });
  });

  it('turns a rejected Stripe call into a 400 rather than a 500 that alarms', async () => {
    // StripeError carries statusCode, which the shared error handler does not read.
    mockFindCancelable.mockResolvedValue(subscriptionRow());
    mockRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ statusCode: 400, message: 'No such subscription: sub_1' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Stripe rejected the cancellation: No such subscription: sub_1',
    });
  });

  it('leaves a genuine Stripe fault as a 5xx', async () => {
    // Only user-facing rejections are remapped - a Stripe outage is still an incident.
    mockFindCancelable.mockResolvedValue(subscriptionRow());
    const stripeFault = new Stripe.errors.StripeAPIError({ statusCode: 500, message: 'Stripe is down' });
    mockRetrieve.mockRejectedValue(stripeFault);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toBe(stripeFault);
  });

  it('still returns 200 when the invoice cleanup fails', async () => {
    // The cancel already happened at Stripe; a 5xx would tell the user nothing did.
    mockFindCancelable.mockResolvedValue(subscriptionRow());
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'past_due' });
    mockCancel.mockResolvedValue({ id: 'sub_1', canceled_at: 1700000000 });
    mockVoidOpenSubscriptionInvoices.mockRejectedValue(new Error('stripe unavailable'));
    const { req, res } = makeReq();

    await (handler as HandlerFn)(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ priceId: 'price_pro' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects an admin-granted row without calling Stripe', async () => {
    mockFindCancelable.mockResolvedValue(
      subscriptionRow({ source: 'admin_grant', subscriptionId: 'admin_granted_abc' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'This subscription is not managed by Stripe and cannot be canceled here',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a legacy admin-granted row that never got a source field', async () => {
    // resolveSubscriptionSource is the repo's defensive default for pre-source rows.
    mockFindCancelable.mockResolvedValue(
      subscriptionRow({ source: undefined, subscriptionId: 'admin_granted_legacy' })
    );
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('is a 400 when no cancellable subscription matches', async () => {
    mockFindCancelable.mockResolvedValue(null);
    const { req, res } = makeReq();

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'User does not have an active subscription to cancel',
    });

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockVoidOpenSubscriptionInvoices).not.toHaveBeenCalled();
  });
});
