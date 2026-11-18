import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userLean: vi.fn(),
  userExists: vi.fn(),
  orgExists: vi.fn(),
  subscriptionList: vi.fn(),
  cancel: vi.fn(),
  invoiceList: vi.fn(),
  voidInvoice: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
  methods: vi.fn(),
  taxIds: vi.fn(),
  detach: vi.fn(),
  deleteTaxId: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: () => ({ select: () => ({ lean: mocks.userLean }) }), exists: mocks.userExists },
  Organization: { exists: () => ({ setOptions: mocks.orgExists }) },
  userRepository: { findById: vi.fn() },
}));
vi.mock('../integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: {
    subscriptions: { list: mocks.subscriptionList, cancel: mocks.cancel },
    invoices: { list: mocks.invoiceList, voidInvoice: mocks.voidInvoice },
    customers: {
      retrieve: mocks.retrieve,
      update: mocks.update,
      listPaymentMethods: mocks.methods,
      listTaxIds: mocks.taxIds,
      deleteTaxId: mocks.deleteTaxId,
    },
    paymentMethods: { detach: mocks.detach },
  },
}));

// Cancellation and dunning are real here; only transport and ordinary repository reads are doubled.
import { redactAccountStripeCustomer } from './redactAccountStripeCustomer';
import { cancelAccountSubscriptions } from './cancelAccountSubscriptions';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const customerId = 'cus_owned';
const subscription = (id: string) => ({ id, status: 'active' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
function lease(error: unknown = new Error('lease no longer owned')) {
  let owned = true;
  return {
    error,
    lose: () => {
      owned = false;
    },
    assertLease: vi.fn(async () => {
      if (!owned) throw error;
    }),
  };
}
const run = (owner: ReturnType<typeof lease>) =>
  redactAccountStripeCustomer('user-1', { logger, assertLease: owner.assertLease });
const noRedaction = () => {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.detach).not.toHaveBeenCalled();
  expect(mocks.deleteTaxId).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.userLean.mockResolvedValue({ stripeCustomerId: customerId });
  mocks.userExists.mockResolvedValue(null);
  mocks.orgExists.mockResolvedValue(null);
  mocks.retrieve.mockResolvedValue({ id: customerId, metadata: { type: 'User' } });
  mocks.subscriptionList.mockResolvedValue({ data: [subscription('sub-a')] });
  mocks.cancel.mockResolvedValue({});
  mocks.invoiceList.mockResolvedValue({ data: [] });
  mocks.voidInvoice.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
  mocks.methods.mockResolvedValue({ data: [] });
  mocks.taxIds.mockResolvedValue({ data: [] });
});

afterEach(() => vi.useRealTimers());

describe('real account Stripe cleanup lease boundaries', () => {
  it('refuses cancellation after lease loss during customer retrieval', async () => {
    const owner = lease();
    mocks.retrieve.mockImplementationOnce(async () => {
      owner.lose();
      return { id: customerId, metadata: { type: 'User' } };
    });
    await expect(run(owner)).rejects.toBe(owner.error);
    expect(mocks.subscriptionList).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    noRedaction();
  });

  it('does not cancel when ownership is lost during subscription listing', async () => {
    const owner = lease();
    const pending = deferred<{ data: ReturnType<typeof subscription>[] }>();
    mocks.subscriptionList.mockReturnValueOnce(pending.promise);
    const outcome = expect(run(owner)).rejects.toBe(owner.error);
    await vi.waitFor(() => expect(mocks.subscriptionList).toHaveBeenCalledOnce());
    owner.lose();
    pending.resolve({ data: [subscription('sub-a')] });
    await outcome;
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    noRedaction();
  });

  it('stops before a second cancellation after the first write loses the lease', async () => {
    const owner = lease();
    mocks.subscriptionList.mockResolvedValueOnce({ data: [subscription('sub-a'), subscription('sub-b')] });
    mocks.cancel.mockImplementationOnce(async () => {
      owner.lose();
      return {};
    });
    await expect(run(owner)).rejects.toBe(owner.error);
    expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual(['sub-a']);
    noRedaction();
  });

  it('propagates a lease rejection between invoice writes without redaction', async () => {
    const owner = lease();
    mocks.subscriptionList.mockResolvedValueOnce({ data: [subscription('sub-a'), subscription('sub-b')] });
    mocks.invoiceList.mockResolvedValueOnce({ data: [{ id: 'invoice-a' }, { id: 'invoice-b' }] });
    mocks.voidInvoice.mockImplementationOnce(async () => {
      owner.lose();
      return {};
    });
    await expect(run(owner)).rejects.toBe(owner.error);
    expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual(['sub-a']);
    expect(mocks.voidInvoice.mock.calls.map(call => call[0])).toEqual(['invoice-a']);
    noRedaction();
  });

  it('stops before invoice writes after lease loss during their listing', async () => {
    const owner = lease();
    const pending = deferred<{ data: { id: string }[] }>();
    mocks.invoiceList.mockReturnValueOnce(pending.promise);
    const outcome = expect(run(owner)).rejects.toBe(owner.error);
    await vi.waitFor(() => expect(mocks.invoiceList).toHaveBeenCalledOnce());
    owner.lose();
    pending.resolve({ data: [{ id: 'invoice-a' }] });
    await outcome;
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    noRedaction();
  });

  it('propagates even a falsy checkpoint rejection', async () => {
    const owner = lease(false);
    mocks.invoiceList.mockResolvedValueOnce({ data: [{ id: 'invoice-a' }, { id: 'invoice-b' }] });
    mocks.voidInvoice.mockImplementationOnce(async () => {
      owner.lose();
      return {};
    });
    await expect(run(owner)).rejects.toBe(false);
    expect(mocks.voidInvoice.mock.calls.map(call => call[0])).toEqual(['invoice-a']);
    noRedaction();
  });

  it.each(['cancel', 'void'] as const)(
    'propagates falsy %s checkpoint rejection from the cancellation helper',
    async phase => {
      mocks.invoiceList.mockResolvedValueOnce({ data: [{ id: 'invoice-a' }] });
      const beforeWrite = vi.fn(async () => {
        if (phase === 'cancel' || mocks.cancel.mock.calls.length > 0) throw false;
      });
      await expect(
        cancelAccountSubscriptions(
          { userId: 'user-1', reason: 'account_deleted', customerIds: [customerId], beforeWrite },
          logger
        )
      ).rejects.toBe(false);
      expect(mocks.cancel).toHaveBeenCalledTimes(phase === 'cancel' ? 0 : 1);
      expect(mocks.voidInvoice).not.toHaveBeenCalled();
    }
  );

  it('does not cancel when its checkpoint consumes the remaining deadline', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 100;
    const result = await cancelAccountSubscriptions(
      {
        userId: 'user-1',
        reason: 'account_deleted',
        customerIds: [customerId],
        deadline,
        beforeWrite: async () => {
          vi.setSystemTime(deadline);
        },
      },
      logger
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({
      canceled: [],
      failed: [{ customerId, subscriptionId: 'sub-a', reason: 'time budget exhausted' }],
    });
  });

  it('does not void invoices when their checkpoint consumes the remaining deadline', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 100;
    mocks.invoiceList.mockResolvedValueOnce({ data: [{ id: 'invoice-a' }] });
    const result = await cancelAccountSubscriptions(
      {
        userId: 'user-1',
        reason: 'account_deleted',
        customerIds: [customerId],
        deadline,
        beforeWrite: async () => {
          if (mocks.cancel.mock.calls.length > 0) vi.setSystemTime(deadline);
        },
      },
      logger
    );
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.voidInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ canceled: ['sub-a'], failed: [] });
    expect(logger.info).toHaveBeenCalledWith('[Billing] voided open invoices after canceling a subscription', {
      subscriptionId: 'sub-a',
      voided: 0,
      failed: 1,
    });
  });

  it.each([false, true])('preserves ordinary Stripe failure aggregation with checkpoint=%s', async withCheckpoint => {
    const owner = lease();
    mocks.subscriptionList.mockResolvedValueOnce({ data: [subscription('sub-a'), subscription('sub-b')] });
    mocks.cancel.mockRejectedValueOnce(new Error('cancel failed'));
    mocks.invoiceList.mockResolvedValueOnce({ data: [{ id: 'invoice-a' }, { id: 'invoice-b' }] });
    mocks.voidInvoice.mockRejectedValueOnce(new Error('void failed'));
    const result = await cancelAccountSubscriptions(
      {
        userId: 'user-1',
        reason: 'account_deleted',
        customerIds: [customerId],
        ...(withCheckpoint ? { beforeWrite: owner.assertLease } : {}),
      },
      logger
    );
    expect(result).toEqual({
      canceled: ['sub-b'],
      failed: [{ customerId, subscriptionId: 'sub-a', reason: 'cancel failed' }],
    });
    expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual(['sub-a', 'sub-b']);
    expect(mocks.voidInvoice.mock.calls.map(call => call[0])).toEqual(['invoice-a', 'invoice-b']);
    expect(logger.info).toHaveBeenCalledWith('[Billing] voided open invoices after canceling a subscription', {
      subscriptionId: 'sub-b',
      voided: 1,
      failed: 1,
    });
  });
});
