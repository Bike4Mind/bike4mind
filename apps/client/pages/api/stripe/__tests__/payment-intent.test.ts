// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi: unwrap the chain so handler.get(fn) just returns fn. The options it was built with are
// kept outside vi's mock registry, so clearAllMocks between tests cannot wipe them.
const built = vi.hoisted(() => ({ options: undefined as unknown }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: unknown) => {
    built.options = options;
    return {
      use: function () {
        return this;
      },
      get: (fn: unknown) => fn,
    };
  },
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

const mockIntentsRetrieve = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    paymentIntents: { retrieve: (...args: unknown[]) => mockIntentsRetrieve(...args) },
  },
}));

import handler from '../payment-intent';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const OWNER_ID = 'user_1';

/** A succeeded credit-package payment belonging to OWNER_ID, as start-payment creates it. */
function paidIntent(overrides: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: 'pi_test_1',
    status: 'succeeded',
    amount: 2000,
    amount_received: 2000,
    currency: 'usd',
    description: 'Credits package (10,000)',
    metadata: { userId: OWNER_ID, transactionType: 'package', credits: '10000', packageId: 'starter', ...metadata },
    ...overrides,
  };
}

function call(intentId: string | undefined, userId = OWNER_ID) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).query = intentId === undefined ? {} : { id: intentId };
  (req as Record<string, unknown>).user = { id: userId };
  return { promise: (handler as unknown as HandlerFn)(req, res), res };
}

describe('GET /api/stripe/payment-intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts browser sessions only, never an API key', () => {
    expect(built.options).toEqual({ auth: 'jwtOnly' });
  });

  it('returns the purchase facts in major currency units, marked as a credit purchase', async () => {
    mockIntentsRetrieve.mockResolvedValue(paidIntent());

    const { promise, res } = call('pi_test_1');
    await promise;

    expect(mockIntentsRetrieve).toHaveBeenCalledWith('pi_test_1');
    expect(res._getJSONData()).toEqual({
      transactionId: 'pi_test_1',
      value: 20,
      currency: 'USD',
      priceId: 'credits-starter',
      planName: 'Credits package (10,000)',
      quantity: 1,
      kind: 'credits',
    });
  });

  it('names a per-credit purchase without a package', async () => {
    mockIntentsRetrieve.mockResolvedValue(paidIntent({}, { transactionType: 'per-credit', packageId: '' }));

    const { promise, res } = call('pi_test_1');
    await promise;

    expect(res._getJSONData().priceId).toBe('credits');
  });

  it('reports the amount received, not the amount asked', async () => {
    mockIntentsRetrieve.mockResolvedValue(paidIntent({ amount: 2000, amount_received: 1500 }));

    const { promise, res } = call('pi_test_1');
    await promise;

    expect(res._getJSONData().value).toBe(15);
  });

  it('rejects a missing or malformed id without calling Stripe', async () => {
    await expect(call(undefined).promise).rejects.toThrow();
    await expect(call('cs_test_1').promise).rejects.toThrow();
    expect(mockIntentsRetrieve).not.toHaveBeenCalled();
  });

  it("refuses another user's payment, or one with no owner", async () => {
    mockIntentsRetrieve.mockResolvedValue(paidIntent());
    await expect(call('pi_test_1', 'someone_else').promise).rejects.toThrow(/not found/i);

    mockIntentsRetrieve.mockResolvedValue(paidIntent({ metadata: { credits: '10000' } }));
    await expect(call('pi_test_1').promise).rejects.toThrow(/not found/i);
  });

  it('refuses a payment that is not a credit purchase', async () => {
    for (const credits of ['', '0', '-5', 'abc']) {
      mockIntentsRetrieve.mockResolvedValue(paidIntent({}, { credits }));
      await expect(call('pi_test_1').promise, credits).rejects.toThrow(/not found/i);
    }
  });

  it('never reports a payment that has not settled, or moved no money', async () => {
    for (const status of ['processing', 'requires_payment_method', 'requires_action', 'canceled']) {
      mockIntentsRetrieve.mockResolvedValue(paidIntent({ status }));
      await expect(call('pi_test_1').promise, status).rejects.toThrow(/completed payment/i);
    }
    mockIntentsRetrieve.mockResolvedValue(paidIntent({ amount_received: 0 }));
    await expect(call('pi_test_1').promise).rejects.toThrow(/completed payment/i);
  });

  it('answers not found for an id Stripe does not know', async () => {
    const Stripe = (await import('stripe')).default;
    mockIntentsRetrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing' })
    );
    await expect(call('pi_missing').promise).rejects.toThrow(/not found/i);
  });

  it('does not divide by 100 for a zero-decimal currency', async () => {
    mockIntentsRetrieve.mockResolvedValue(paidIntent({ currency: 'jpy', amount: 3000, amount_received: 3000 }));

    const { promise, res } = call('pi_test_1');
    await promise;

    expect(res._getJSONData()).toMatchObject({ value: 3000, currency: 'JPY' });
  });
});
