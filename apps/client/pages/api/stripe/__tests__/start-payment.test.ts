// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@server/utils/errors';
import { CreditPackageId, TransactionType } from '@client/lib/credits/types';
import { CreditPurchaseEvents, MIN_PRICE_PER_CREDIT_USD } from '@bike4mind/common';

// baseApi: unwrap the chain so handler.post(fn) just returns fn, and .use() is a no-op.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: function () {
      return this;
    },
    post: (fn: unknown) => fn,
  }),
}));

// requireStripeWebhook is applied via .use(), which our baseApi mock drops. Stub the
// factory so importing the handler module doesn't touch real webhook config.
vi.mock('@server/middlewares/requireStripeWebhook', () => ({
  requireStripeWebhook: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockUserUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    update: (...args: unknown[]) => mockUserUpdate(...args),
  },
  adminSettingsRepository: {},
}));

let storedSettings: Record<string, unknown> = {};
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: () => Promise.resolve(storedSettings),
}));

const mockCreateCustomer = vi.fn();
const mockPaymentIntentsCreate = vi.fn();
const mockCustomersDel = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  CustomerType: { User: 'user' },
  stripe: {
    paymentIntents: {
      create: (...args: unknown[]) => mockPaymentIntentsCreate(...args),
    },
    customers: {
      del: (...args: unknown[]) => mockCustomersDel(...args),
    },
  },
}));

const mockLogEventSafe = vi.fn();
vi.mock('@server/utils/analyticsLog', () => ({
  logEventSafe: (...args: unknown[]) => mockLogEventSafe(...args),
}));

const mockHandlePerCredit = vi.fn();
const mockHandlePackage = vi.fn();
vi.mock('@client/lib/credits/utils', () => ({
  handlePerCreditTransaction: (...args: unknown[]) => mockHandlePerCredit(...args),
  handlePackageTransaction: (...args: unknown[]) => mockHandlePackage(...args),
}));

vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test', STRIPE_PUBLISHABLE_KEY: 'pk_test_123' },
}));

import handler from '../start-payment';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

// A minimal non-subscribed user. The route no longer looks up subscriptions at all,
// so the absence of any subscription state IS the "non-subscriber" case.
function makeReq(body: unknown, userOverrides: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).body = body;
  (req as Record<string, unknown>).user = {
    id: 'user_1',
    email: 'buyer@example.com',
    name: 'Buyer',
    stripeCustomerId: 'cus_existing',
    disputePending: false,
    ...userOverrides,
  };
  (req as Record<string, unknown>).logger = { info: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/stripe/start-payment (pay-as-you-go, no subscription required)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandlePackage.mockResolvedValue({
      amount: 1000,
      description: 'credits package',
      metadata: { credits: 10000, packageId: CreditPackageId.A },
    });
    mockHandlePerCredit.mockResolvedValue({
      amount: 500,
      description: 'credits',
      metadata: { credits: 500, pricePerCredit: '0.01' },
    });
    mockPaymentIntentsCreate.mockResolvedValue({ client_secret: 'cs_test_abc', id: 'pi_1' });
    mockCustomersDel.mockResolvedValue({ id: 'cus_new', deleted: true });
  });

  it('creates a payment intent for a non-subscribed user buying a package', async () => {
    const { req, res } = makeReq({ transactionType: TransactionType.Package, packageId: CreditPackageId.A });

    await (handler as HandlerFn)(req, res);

    expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res._getData()).toEqual({
      clientSecret: 'cs_test_abc',
      publishableKey: 'pk_test_123',
      paymentIntentId: 'pi_1',
    });
  });

  it('creates a payment intent for a non-subscribed user buying per-credit', async () => {
    const { req, res } = makeReq({ transactionType: TransactionType.PerCredit, credits: 500 });

    await (handler as HandlerFn)(req, res);

    expect(mockHandlePerCredit).toHaveBeenCalledTimes(1);
    expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('creates a Stripe customer on the fly when the user has none', async () => {
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    const { req, res } = makeReq(
      { transactionType: TransactionType.Package, packageId: CreditPackageId.A },
      { stripeCustomerId: null }
    );

    await (handler as HandlerFn)(req, res);

    expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    expect(mockUserUpdate).toHaveBeenCalledWith({ id: 'user_1', stripeCustomerId: 'cus_new' });
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_new' }));
    expect(mockCustomersDel).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('deletes and never persists a new customer when the payment intent cannot be created', async () => {
    mockCreateCustomer.mockResolvedValue({ id: 'cus_new' });
    mockPaymentIntentsCreate.mockRejectedValue(new Error('stripe down'));
    const { req, res } = makeReq(
      { transactionType: TransactionType.Package, packageId: CreditPackageId.A },
      { stripeCustomerId: null }
    );

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('stripe down');
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockCustomersDel).toHaveBeenCalledWith('cus_new');
    expect(mockLogEventSafe).not.toHaveBeenCalled();
  });

  it('never deletes an existing customer when the payment intent cannot be created', async () => {
    mockPaymentIntentsCreate.mockRejectedValue(new Error('stripe down'));
    const { req, res } = makeReq({ transactionType: TransactionType.Package, packageId: CreditPackageId.A });

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('stripe down');
    expect(mockCustomersDel).not.toHaveBeenCalled();
  });

  it('creates no customer when the purchase cannot be priced', async () => {
    mockHandlePerCredit.mockRejectedValue(new Error('pricePerCredit setting missing'));
    const { req, res } = makeReq(
      { transactionType: TransactionType.PerCredit, credits: 500 },
      { stripeCustomerId: null }
    );

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('pricePerCredit setting missing');
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('refuses a per-credit purchase when the configured price is below the floor', async () => {
    // Real pricing, not the mock: a stored price that predates the save-time floor must still be
    // caught before any Stripe object exists.
    const actual = await vi.importActual<typeof import('@client/lib/credits/utils')>('@client/lib/credits/utils');
    mockHandlePerCredit.mockImplementation(actual.handlePerCreditTransaction);
    storedSettings = { pricePerCredit: String(MIN_PRICE_PER_CREDIT_USD / 2) };
    const { req, res } = makeReq(
      { transactionType: TransactionType.PerCredit, credits: 100_000 },
      { stripeCustomerId: null }
    );

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 500 });
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    const { logger } = req as unknown as { logger: { error: ReturnType<typeof vi.fn> } };
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { userId: 'user_1' });
  });

  it('refuses a per-credit total above the card maximum before creating any Stripe object', async () => {
    const actual = await vi.importActual<typeof import('@client/lib/credits/utils')>('@client/lib/credits/utils');
    mockHandlePerCredit.mockImplementation(actual.handlePerCreditTransaction);
    storedSettings = { pricePerCredit: '1000' };
    const { req, res } = makeReq(
      { transactionType: TransactionType.PerCredit, credits: 1_000_000 },
      { stripeCustomerId: null }
    );

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreateCustomer).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('records a PII-free checkout-started marker keyed by the payment intent id', async () => {
    const { req, res } = makeReq({ transactionType: TransactionType.Package, packageId: CreditPackageId.A });

    await (handler as HandlerFn)(req, res);

    expect(mockLogEventSafe).toHaveBeenCalledTimes(1);
    const [event] = mockLogEventSafe.mock.calls[0];
    expect(event).toEqual({
      type: CreditPurchaseEvents.CHECKOUT_STARTED,
      userId: 'user_1',
      metadata: {
        paymentIntentId: 'pi_1',
        transactionType: TransactionType.Package,
        amount: 1000,
        credits: 10000,
        packageId: CreditPackageId.A,
      },
    });
    expect(JSON.stringify(event)).not.toContain('buyer@example.com');
    expect(JSON.stringify(event)).not.toContain('cs_test_abc');
  });

  it('blocks a user with an open payment dispute before creating any payment intent', async () => {
    const { req, res } = makeReq(
      { transactionType: TransactionType.Package, packageId: CreditPackageId.A },
      { disputePending: true }
    );

    await expect((handler as HandlerFn)(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('rejects a per-credit request with a non-positive credit amount', async () => {
    const { req, res } = makeReq({ transactionType: TransactionType.PerCredit, credits: 0 });

    await expect((handler as HandlerFn)(req, res)).rejects.toBeTruthy();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });
});
