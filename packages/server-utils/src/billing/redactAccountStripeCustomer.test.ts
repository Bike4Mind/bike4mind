import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  isStripeConfigured: vi.fn(),
  userLean: vi.fn(),
  userExists: vi.fn(),
  orgExists: vi.fn(),
  orgOptions: vi.fn(),
  cancel: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
  listPaymentMethods: vi.fn(),
  detach: vi.fn(),
  listTaxIds: vi.fn(),
  deleteTaxId: vi.fn(),
  del: vi.fn(),
  invoices: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: () => ({ select: () => ({ lean: mocks.userLean }) }),
    exists: mocks.userExists,
  },
  Organization: {
    exists: () => ({
      setOptions: (options: unknown) => {
        mocks.orgOptions(options);
        return mocks.orgExists();
      },
    }),
  },
}));
vi.mock('../integrations/stripe/stripe', () => ({
  isStripeConfigured: mocks.isStripeConfigured,
  stripe: {
    customers: {
      retrieve: mocks.retrieve,
      update: mocks.update,
      del: mocks.del,
      listPaymentMethods: mocks.listPaymentMethods,
      listTaxIds: mocks.listTaxIds,
      deleteTaxId: mocks.deleteTaxId,
    },
    paymentMethods: { detach: mocks.detach },
    invoices: { update: mocks.invoices, del: mocks.invoices },
  },
}));
vi.mock('./cancelAccountSubscriptions', () => ({
  STRIPE_REQUEST_TIMEOUT_MS: 10_000,
  cancelAccountSubscriptions: mocks.cancel,
}));

import { redactAccountStripeCustomer } from './redactAccountStripeCustomer';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const assertLease = vi.fn();
const run = () => redactAccountStripeCustomer('user-1', { logger, assertLease });
const noStripeWrites = () => {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.detach).not.toHaveBeenCalled();
  expect(mocks.deleteTaxId).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
};

describe('redactAccountStripeCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStripeConfigured.mockReturnValue(true);
    mocks.userLean.mockResolvedValue({ stripeCustomerId: 'cus_user' });
    mocks.userExists.mockResolvedValue(null);
    mocks.orgExists.mockResolvedValue(null);
    mocks.retrieve.mockResolvedValue({ id: 'cus_user', metadata: { type: 'User', stage: 'prod', note: 'x' } });
    mocks.cancel.mockResolvedValue({ canceled: ['sub_1'], failed: [] });
    mocks.update.mockResolvedValue({});
    mocks.listPaymentMethods.mockResolvedValue({ data: [{ id: 'pm_1' }, { id: 'pm_2' }] });
    mocks.listTaxIds.mockResolvedValue({ data: [{ id: 'txi_1' }] });
    mocks.detach.mockResolvedValue({});
    mocks.deleteTaxId.mockResolvedValue({});
    assertLease.mockResolvedValue(undefined);
  });

  it('redacts the personal data and keeps invoices', async () => {
    await expect(run()).resolves.toEqual({ outcome: 'redacted', customerId: 'cus_user' });

    expect(mocks.update).toHaveBeenCalledWith(
      'cus_user',
      {
        name: '',
        email: '',
        phone: '',
        description: '',
        address: '',
        shipping: '',
        metadata: { erased: 'true', note: '' },
      },
      expect.any(Object)
    );
    expect(mocks.detach.mock.calls.map(c => c[0])).toEqual(['pm_1', 'pm_2']);
    expect(mocks.deleteTaxId.mock.calls.map(c => c[1])).toEqual(['txi_1']);
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.invoices).not.toHaveBeenCalled();
  });

  it('cancels subscriptions of that customer before redacting', async () => {
    const order: string[] = [];
    mocks.cancel.mockImplementation(async () => {
      order.push('cancel');
      return { canceled: [], failed: [] };
    });
    mocks.update.mockImplementation(async () => order.push('update'));

    await run();

    expect(mocks.cancel).toHaveBeenCalledWith(
      { userId: 'user-1', reason: 'account_deleted', customerIds: ['cus_user'] },
      logger
    );
    expect(order).toEqual(['cancel', 'update']);
  });

  it('throws without redacting when a subscription cannot be canceled', async () => {
    mocks.cancel.mockResolvedValue({
      canceled: [],
      failed: [{ customerId: 'cus_user', subscriptionId: 's', reason: 'x' }],
    });

    await expect(run()).rejects.toThrow(/not redacted/);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  it('is idempotent on an already-redacted customer', async () => {
    mocks.retrieve.mockResolvedValue({ id: 'cus_user', metadata: { type: 'User', stage: 'prod', erased: 'true' } });
    mocks.listPaymentMethods.mockResolvedValue({ data: [] });
    mocks.listTaxIds.mockResolvedValue({ data: [] });

    await expect(run()).resolves.toEqual({ outcome: 'redacted', customerId: 'cus_user' });
    expect(mocks.update.mock.calls[0][1].metadata).toEqual({ erased: 'true' });
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.deleteTaxId).not.toHaveBeenCalled();
  });

  it.each([
    ['a deleted customer', () => mocks.retrieve.mockResolvedValue({ id: 'cus_user', deleted: true })],
    [
      'a missing customer',
      () => mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' })),
    ],
  ])('treats %s as done', async (_name, arrange) => {
    arrange();
    await expect(run()).resolves.toEqual({ outcome: 'alreadyDeleted' });
    noStripeWrites();
  });

  it('rethrows other Stripe read errors', async () => {
    mocks.retrieve.mockRejectedValue(new Error('rate limited'));
    await expect(run()).rejects.toThrow('rate limited');
  });

  it('does nothing without a customer', async () => {
    mocks.userLean.mockResolvedValue({ stripeCustomerId: null });
    await expect(run()).resolves.toEqual({ outcome: 'noCustomer' });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    noStripeWrites();
  });

  it('does nothing when Stripe is not configured', async () => {
    mocks.isStripeConfigured.mockReturnValue(false);
    await expect(run()).resolves.toEqual({ outcome: 'notConfigured' });
    expect(mocks.userLean).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    noStripeWrites();
  });

  describe('ownership boundary', () => {
    it('skips a customer an organization also holds, soft-deleted included', async () => {
      mocks.orgExists.mockResolvedValue({ _id: 'org-1' });
      await expect(run()).resolves.toEqual({ outcome: 'skippedShared' });
      expect(mocks.orgOptions).toHaveBeenCalledWith({ includeDeleted: true });
      expect(logger.warn).toHaveBeenCalled();
      noStripeWrites();
    });

    it('skips a customer another user also holds', async () => {
      mocks.userExists.mockResolvedValue({ _id: 'user-2' });
      await expect(run()).resolves.toEqual({ outcome: 'skippedShared' });
      noStripeWrites();
    });

    it('skips a customer typed as an organization', async () => {
      mocks.retrieve.mockResolvedValue({ id: 'cus_user', metadata: { type: 'Organization' } });
      await expect(run()).resolves.toEqual({ outcome: 'skippedShared' });
      noStripeWrites();
    });
  });
});
