// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import Stripe from 'stripe';
import { BadRequestError, ConflictError } from '@bike4mind/common';

const baseApiMock = vi.hoisted(() => {
  const state: { options?: unknown } = {};
  const fn = vi.fn((options?: unknown) => {
    state.options = options;
    return {
      use: function () {
        return this;
      },
      post: (handler: unknown) => handler,
    };
  });
  return { fn, state };
});
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: baseApiMock.fn }));

vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockFindByStripeId = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByStripeSubscriptionId: (...args: unknown[]) => mockFindByStripeId(...args),
  },
}));

const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
}));

const mockRetrieve = vi.fn();
const mockPay = vi.fn();
const mockListInvoices = vi.fn();
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
    invoices: {
      pay: (...args: unknown[]) => mockPay(...args),
      list: (...args: unknown[]) => mockListInvoices(...args),
    },
  },
}));

import handler from '../pay-invoice';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const HOSTED_URL = 'https://invoice.stripe.com/i/acct_x/test_123';

const userRow = (overrides: Record<string, unknown> = {}) => ({
  ownerType: 'User',
  ownerId: 'user_1',
  status: 'past_due',
  source: 'stripe',
  subscriptionId: 'sub_1',
  ...overrides,
});

const liveSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  customer: 'cus_1',
  ...overrides,
});

const openInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'in_1',
  status: 'open',
  created: 1_700_000_000,
  hosted_invoice_url: HOSTED_URL,
  ...overrides,
});

function makeReq(user: Record<string, unknown> = { id: 'user_1', stripeCustomerId: 'cus_1' }) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = { subscriptionId: 'sub_1' };
  (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = logger;
  return { req, res };
}

const run = async (user?: Record<string, unknown>) => {
  const { req, res } = makeReq(user);
  await (handler as HandlerFn)(req, res);
  return res;
};

describe('POST /api/subscriptions/pay-invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByStripeId.mockResolvedValue(userRow());
    mockRetrieve.mockResolvedValue(liveSubscription());
    mockListInvoices.mockResolvedValue({ data: [openInvoice()] });
    mockPay.mockResolvedValue({ id: 'in_1', status: 'paid' });
  });

  it('is jwtOnly, so an API key cannot charge the card', () => {
    expect(baseApiMock.state.options).toEqual({ auth: 'jwtOnly' });
  });

  it('pays the open invoice for the owning user', async () => {
    const res = await run();

    expect(mockRetrieve).toHaveBeenCalledWith('sub_1');
    expect(mockListInvoices).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'open', limit: 100 });
    expect(mockPay).toHaveBeenCalledWith('in_1');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'paid' });
  });

  it('refuses another user without touching Stripe', async () => {
    await expect(run({ id: 'user_2', stripeCustomerId: 'cus_2' })).rejects.toMatchObject({
      constructor: BadRequestError,
      message: 'Subscription not found',
    });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('refuses a request with no user before looking anything up', async () => {
    const { req, res } = makeReq();
    (req as Record<string, unknown>).user = undefined;
    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      message: 'Subscription not found',
    });
    expect(mockFindByStripeId).not.toHaveBeenCalled();
  });

  it('answers an unknown subscription exactly like one owned by someone else', async () => {
    mockFindByStripeId.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ constructor: BadRequestError, message: 'Subscription not found' });
  });

  it('pays an org invoice for the org owner against the org customer', async () => {
    mockFindByStripeId.mockResolvedValue(userRow({ ownerType: 'Organization', ownerId: 'org_1' }));
    mockOrgFindById.mockResolvedValue({ id: 'org_1', userId: 'user_1', stripeCustomerId: 'cus_org' });
    mockRetrieve.mockResolvedValue(liveSubscription({ customer: 'cus_org' }));

    const res = await run();

    expect(mockOrgFindById).toHaveBeenCalledWith('org_1');
    expect(mockPay).toHaveBeenCalledWith('in_1');
    expect(res._getJSONData()).toEqual({ status: 'paid' });
  });

  it('refuses an org member who is not the owner', async () => {
    mockFindByStripeId.mockResolvedValue(userRow({ ownerType: 'Organization', ownerId: 'org_1' }));
    mockOrgFindById.mockResolvedValue({ id: 'org_1', userId: 'owner_9', stripeCustomerId: 'cus_org' });

    await expect(run()).rejects.toMatchObject({ constructor: BadRequestError, message: 'Subscription not found' });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('refuses when the Stripe subscription belongs to a different customer', async () => {
    mockRetrieve.mockResolvedValue(liveSubscription({ customer: { id: 'cus_other' } }));

    await expect(run()).rejects.toMatchObject({ constructor: BadRequestError, message: 'Subscription not found' });
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('refuses when the owner has no Stripe customer on file', async () => {
    await expect(run({ id: 'user_1', stripeCustomerId: null })).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('refuses an admin-granted row', async () => {
    mockFindByStripeId.mockResolvedValue(userRow({ source: 'admin_grant' }));

    await expect(run()).rejects.toMatchObject({
      constructor: BadRequestError,
      message: 'This subscription is not billed through Stripe',
    });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it.each(['active', 'canceled', 'trialing'])('answers 409 for a %s row', async status => {
    mockFindByStripeId.mockResolvedValue(userRow({ status }));

    await expect(run()).rejects.toMatchObject({ constructor: ConflictError, statusCode: 409 });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('answers 409 when the subscription has no open invoice', async () => {
    mockListInvoices.mockResolvedValue({ data: [] });

    await expect(run()).rejects.toMatchObject({ constructor: ConflictError, statusCode: 409 });
    expect(mockPay).not.toHaveBeenCalled();
  });

  it('pays every open invoice oldest first, so an older failed renewal is not left open', async () => {
    mockListInvoices.mockResolvedValue({
      data: [openInvoice({ id: 'in_new', created: 1_700_100_000 }), openInvoice({ id: 'in_old' })],
    });

    const res = await run();

    expect(mockPay.mock.calls).toEqual([['in_old'], ['in_new']]);
    expect(res._getJSONData()).toEqual({ status: 'paid' });
  });

  it('stops at the first invoice that needs the hosted page', async () => {
    mockListInvoices.mockResolvedValue({
      data: [openInvoice({ id: 'in_new', created: 1_700_100_000 }), openInvoice({ id: 'in_old' })],
    });
    mockPay.mockResolvedValueOnce({ id: 'in_old', status: 'open' });

    const res = await run();

    expect(mockPay.mock.calls).toEqual([['in_old']]);
    expect(res._getJSONData()).toEqual({ status: 'requires_action', hostedInvoiceUrl: HOSTED_URL });
  });

  it('sends the user to the hosted page when the payment is not settled yet', async () => {
    mockPay.mockResolvedValue({ id: 'in_1', status: 'open' });

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'requires_action', hostedInvoiceUrl: HOSTED_URL });
  });

  it('fails loudly when an invoice needing action has no hosted URL', async () => {
    mockListInvoices.mockResolvedValue({ data: [openInvoice({ hosted_invoice_url: null })] });
    mockPay.mockResolvedValue({ id: 'in_1', status: 'open' });

    await expect(run()).rejects.toThrow('Open invoice in_1 has no hosted_invoice_url');
  });

  it('answers 402 with the customer-facing message on a card decline', async () => {
    mockPay.mockRejectedValue(
      new Stripe.errors.StripeCardError({
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
      })
    );

    await expect(run()).rejects.toMatchObject({ statusCode: 402, message: 'Your card has insufficient funds.' });
  });

  it.each([
    ['invoice_payment_intent_requires_action', {}],
    ['card_declined', { decline_code: 'authentication_required' }],
    ['card_declined', { payment_intent: { status: 'requires_action' } }],
  ])('returns the hosted invoice URL when Stripe needs authentication (%s)', async (code, extra) => {
    mockPay.mockRejectedValue(
      new Stripe.errors.StripeCardError({ type: 'card_error', code, message: 'auth', ...extra } as never)
    );

    const res = await run();

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'requires_action', hostedInvoiceUrl: HOSTED_URL });
  });

  it('answers 409 when a second click finds the invoice already settled at Stripe', async () => {
    mockPay.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'Invoice is already paid' })
    );

    await expect(run()).rejects.toMatchObject({ constructor: ConflictError, statusCode: 409 });
  });

  it('answers 409 when a concurrent click hits the lock the first payment holds', async () => {
    mockPay.mockRejectedValue(
      new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', code: 'lock_timeout', message: 'locked' })
    );

    await expect(run()).rejects.toMatchObject({ constructor: ConflictError, statusCode: 409 });
  });

  it('leaves any other Stripe failure to the usual 500 path', async () => {
    const apiError = new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'boom' });
    mockPay.mockRejectedValue(apiError);

    await expect(run()).rejects.toBe(apiError);
  });
});
