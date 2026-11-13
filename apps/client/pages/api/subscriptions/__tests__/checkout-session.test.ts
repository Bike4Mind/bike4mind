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
const mockFindTeam = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findByStripeCustomerId: (...args: unknown[]) => mockFindTeam(...args),
  },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    checkout: { sessions: { retrieve: (...args: unknown[]) => mockSessionsRetrieve(...args) } },
  },
}));

const mockPlanCreditsPerCycle = vi.fn();
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/planCreditsPerCycle', () => ({
  planCreditsPerCycle: (...args: unknown[]) => mockPlanCreditsPerCycle(...args),
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
    mockPlanCreditsPerCycle.mockImplementation(
      async ({ ownerType, priceId, quantity }: { ownerType: string; priceId?: string; quantity: number }) =>
        ownerType === 'Organization' ? quantity * 1000 : priceId === 'price_pro' ? 50000 : null
    );
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
      credits: 50000,
    });
  });

  it("returns a team checkout's per-seat credits for the seats bought", async () => {
    mockSessionsRetrieve.mockResolvedValue(
      paidSession({
        subscription: { metadata: { userId: OWNER_ID, ownerType: 'Organization' } },
        line_items: { data: [{ price: { id: 'price_team' }, description: 'Team', quantity: 3 }] },
      })
    );

    const { promise, res } = call('cs_test_1');
    await promise;

    expect(res._getJSONData()).toMatchObject({ planName: 'Team', quantity: 3, credits: 3000 });
  });

  it('still returns the conversion facts when the credits lookup fails', async () => {
    mockSessionsRetrieve.mockResolvedValue(paidSession());
    mockPlanCreditsPerCycle.mockRejectedValue(new Error('settings read failed'));

    const { promise, res } = call('cs_test_1');
    await promise;

    const data = res._getJSONData();
    expect(data).toMatchObject({ transactionId: 'cs_test_1', value: 30 });
    expect(data.credits).toBeUndefined();
  });

  it("resolves only the purchasing owner's newly provisioned team", async () => {
    mockSessionsRetrieve.mockResolvedValue(
      paidSession({
        customer: 'cus_team',
        subscription: {
          metadata: { userId: OWNER_ID, ownerType: 'Organization', newOrganizationName: 'New team' },
        },
      })
    );
    mockFindTeam.mockResolvedValue({ id: 'org1', userId: OWNER_ID });
    const first = call('cs_test_1');
    await first.promise;
    expect(first.res._getJSONData()).toMatchObject({ teamCheckout: true, organizationId: 'org1' });
    mockFindTeam.mockResolvedValue({ id: 'org2', userId: 'other' });
    const second = call('cs_test_1');
    await second.promise;
    expect(second.res._getJSONData().organizationId).toBeUndefined();
  });

  it('preserves purchase facts while a new team is pending or its lookup fails', async () => {
    mockSessionsRetrieve.mockResolvedValue(
      paidSession({
        customer: 'cus_team',
        subscription: {
          metadata: { userId: OWNER_ID, ownerType: 'Organization', newOrganizationName: 'New team' },
        },
      })
    );
    mockFindTeam.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('database unavailable'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = call('cs_test_1');
      await result.promise;
      expect(result.res._getJSONData()).toMatchObject({ transactionId: 'cs_test_1', teamCheckout: true });
      expect(result.res._getJSONData().organizationId).toBeUndefined();
    }
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
