// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi: unwrap the chain so handler.get(fn) just returns fn.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    get: (fn: unknown) => fn,
  }),
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

const mockSessionsRetrieve = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    checkout: { sessions: { retrieve: (...args: unknown[]) => mockSessionsRetrieve(...args) } },
  },
}));

import handler from '../checkout-session';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const OWNER_ID = 'user_1';

/** A completed, paid session belonging to OWNER_ID. */
function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 3000,
    currency: 'usd',
    subscription: { metadata: { userId: OWNER_ID } },
    line_items: {
      data: [{ price: { id: 'price_pro' }, description: 'Professional', quantity: 1 }],
    },
    ...overrides,
  };
}

function call(sessionId: string | undefined, userId = OWNER_ID) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).query = sessionId === undefined ? {} : { id: sessionId };
  (req as Record<string, unknown>).user = { id: userId };
  return { promise: (handler as unknown as HandlerFn)(req, res), res };
}

describe('GET /api/subscriptions/checkout-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the purchase facts in major currency units', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession());

    const { promise, res } = call('cs_test_1');
    await promise;

    expect(res._getJSONData()).toEqual({
      transactionId: 'cs_test_1',
      value: 30,
      currency: 'USD',
      priceId: 'price_pro',
      planName: 'Professional',
      quantity: 1,
    });
  });

  it('retrieves the caller-supplied session with the expansions authorization needs', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession());

    await call('cs_test_1').promise;

    // `subscription` must be expanded or the ownership check has no metadata to
    // read; `line_items` carries the price/plan/quantity in the response.
    expect(mockSessionsRetrieve).toHaveBeenCalledWith('cs_test_1', {
      expand: ['subscription', 'line_items'],
    });
  });

  it('rejects a missing or malformed session id without calling Stripe', async () => {
    await expect(call(undefined).promise).rejects.toThrow();
    await expect(call('not-a-session').promise).rejects.toThrow();
    expect(mockSessionsRetrieve).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another user', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession());

    await expect(call('cs_test_1', 'someone_else').promise).rejects.toThrow(/not found/i);
  });

  it('refuses a session with no owner metadata to tie it to a user', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession({ subscription: { metadata: {} } }));

    await expect(call('cs_test_1').promise).rejects.toThrow(/not found/i);
  });

  it('refuses an unexpanded subscription rather than trusting a bare id', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession({ subscription: 'sub_123' }));

    await expect(call('cs_test_1').promise).rejects.toThrow(/not found/i);
  });

  it('never reports an incomplete or unpaid checkout as revenue', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession({ status: 'open' }));
    await expect(call('cs_test_1').promise).rejects.toThrow(/completed payment/i);

    mockSessionsRetrieve.mockResolvedValue(paidSession({ payment_status: 'unpaid' }));
    await expect(call('cs_test_1').promise).rejects.toThrow(/completed payment/i);
  });

  it('refuses a $0 completion - payment_status must be positively paid', async () => {
    // `no_payment_required` is the third member of Stripe's union (a 100%-off
    // coupon or a trial). A denylist that only rejected 'unpaid' would report it
    // as revenue and train ad bidding on non-revenue conversions.
    mockSessionsRetrieve.mockResolvedValue(paidSession({ payment_status: 'no_payment_required', amount_total: 0 }));

    await expect(call('cs_test_1').promise).rejects.toThrow(/completed payment/i);
  });

  it('does not divide by 100 for a zero-decimal currency', async () => {
    // JPY has no minor unit: 3000 JPY is 3000, not 30.
    mockSessionsRetrieve.mockResolvedValue(paidSession({ currency: 'jpy', amount_total: 3000 }));

    const { promise, res } = call('cs_test_1');
    await promise;

    expect(res._getJSONData()).toMatchObject({ value: 3000, currency: 'JPY' });
  });

  it('divides by 1000 for a three-decimal currency', async () => {
    // KWD is thousandths: 5.000 KWD arrives as 5000, so value is 5, not 50.
    mockSessionsRetrieve.mockResolvedValue(paidSession({ currency: 'kwd', amount_total: 5000 }));

    const { promise, res } = call('cs_test_1');
    await promise;

    expect(res._getJSONData()).toMatchObject({ value: 5, currency: 'KWD' });
  });

  it('falls back cleanly when the line item carries no plan detail', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession({ line_items: { data: [] } }));

    const { promise, res } = call('cs_test_1');
    await promise;

    expect(res._getJSONData()).toEqual({
      transactionId: 'cs_test_1',
      value: 30,
      currency: 'USD',
      quantity: 1,
    });
  });
});
