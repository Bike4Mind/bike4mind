import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findOrgs: vi.fn(),
  isStripeConfigured: vi.fn(),
  subscriptionsList: vi.fn(),
  subscriptionsCancel: vi.fn(),
  voidOpenSubscriptionInvoices: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findUser },
  organizationRepository: { find: mocks.findOrgs },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: mocks.isStripeConfigured,
  stripe: { subscriptions: { list: mocks.subscriptionsList, cancel: mocks.subscriptionsCancel } },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));

import { cancelAccountSubscriptions } from './cancelAccountSubscriptions';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const subs = (...rows: Array<[string, string]>) => ({ data: rows.map(([id, status]) => ({ id, status })) });

describe('cancelAccountSubscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStripeConfigured.mockReturnValue(true);
    mocks.findUser.mockResolvedValue({ id: 'user-1', stripeCustomerId: 'cus_user' });
    mocks.findOrgs.mockResolvedValue([]);
    mocks.subscriptionsList.mockResolvedValue(subs());
    mocks.subscriptionsCancel.mockResolvedValue({});
    mocks.voidOpenSubscriptionInvoices.mockResolvedValue({ voided: [], failed: [] });
  });

  it('cancels every live subscription on the user and owned-org customers, without proration', async () => {
    mocks.findOrgs.mockResolvedValue([{ stripeCustomerId: 'cus_org' }, { stripeCustomerId: null }]);
    mocks.subscriptionsList.mockImplementation(async ({ customer }: { customer: string }) =>
      customer === 'cus_user'
        ? subs(['sub_active', 'active'], ['sub_trial', 'trialing'], ['sub_gone', 'canceled'])
        : subs(['sub_org', 'past_due'], ['sub_expired', 'incomplete_expired'])
    );

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger);

    expect(mocks.findOrgs).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(result).toEqual({ canceled: ['sub_active', 'sub_trial', 'sub_org'], failed: [] });
    expect(mocks.subscriptionsCancel).toHaveBeenCalledTimes(3);
    expect(mocks.subscriptionsCancel).toHaveBeenCalledWith(
      'sub_active',
      { prorate: false, cancellation_details: { comment: expect.stringContaining('suspended') } },
      { timeout: expect.any(Number) }
    );
    expect(mocks.subscriptionsList).toHaveBeenCalledWith(
      { customer: 'cus_user', limit: 100 },
      { timeout: expect.any(Number) }
    );
    expect(mocks.voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_org', { timeoutMs: expect.any(Number) });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lists each customer once when an owned org shares the user customer', async () => {
    mocks.findOrgs.mockResolvedValue([{ stripeCustomerId: 'cus_user' }]);

    await cancelAccountSubscriptions({ userId: 'user-1', reason: 'account_deleted' }, logger);

    expect(mocks.subscriptionsList).toHaveBeenCalledTimes(1);
  });

  it('reports a refused cancel and carries on with the rest, logging at error', async () => {
    mocks.subscriptionsList.mockResolvedValue(subs(['sub_a', 'active'], ['sub_b', 'active']));
    mocks.subscriptionsCancel.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'resource_missing' }));

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'contained' }, logger);

    expect(result).toEqual({
      canceled: ['sub_b'],
      failed: [{ customerId: 'cus_user', subscriptionId: 'sub_a', reason: 'resource_missing' }],
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('reports a customer whose subscriptions cannot be listed', async () => {
    mocks.subscriptionsList.mockRejectedValue(new Error('stripe down'));

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger);

    expect(result).toEqual({
      canceled: [],
      failed: [{ customerId: 'cus_user', subscriptionId: null, reason: 'stripe down' }],
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('keeps a cancel that succeeded when voiding its open invoices fails', async () => {
    mocks.subscriptionsList.mockResolvedValue(subs(['sub_a', 'past_due']));
    mocks.voidOpenSubscriptionInvoices.mockRejectedValue(new Error('list failed'));

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger);

    expect(result).toEqual({ canceled: ['sub_a'], failed: [] });
    expect(logger.info).toHaveBeenCalledWith('[Billing] could not void open invoices after canceling a subscription', {
      subscriptionId: 'sub_a',
      error: 'list failed',
    });
  });

  it('logs the invoices voided after a cancel', async () => {
    mocks.subscriptionsList.mockResolvedValue(subs(['sub_a', 'past_due']));
    mocks.voidOpenSubscriptionInvoices.mockResolvedValue({ voided: ['in_1', 'in_2'], failed: ['in_3'] });

    await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger);

    expect(logger.info).toHaveBeenCalledWith('[Billing] voided open invoices after canceling a subscription', {
      subscriptionId: 'sub_a',
      voided: 2,
      failed: 1,
    });
  });

  it('makes no Stripe request past the deadline and reports every unit left', async () => {
    mocks.findOrgs.mockResolvedValue([{ stripeCustomerId: 'cus_org' }]);

    const result = await cancelAccountSubscriptions(
      { userId: 'user-1', reason: 'suspended', deadline: Date.now() - 1 },
      logger
    );

    expect(result).toEqual({
      canceled: [],
      failed: [
        { customerId: 'cus_user', subscriptionId: null, reason: 'time budget exhausted' },
        { customerId: 'cus_org', subscriptionId: null, reason: 'time budget exhausted' },
      ],
    });
    expect(mocks.subscriptionsList).not.toHaveBeenCalled();
    expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
    expect(mocks.voidOpenSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it('stops cancelling once the deadline passes mid-page, failing the rest without voiding', async () => {
    mocks.subscriptionsList.mockResolvedValue(subs(['sub_a', 'active'], ['sub_b', 'active']));
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    mocks.subscriptionsCancel.mockImplementation(async () => {
      now.mockReturnValue(5_000);
      return {};
    });

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended', deadline: 3_000 }, logger);
    now.mockRestore();

    expect(result).toEqual({
      canceled: ['sub_a'],
      failed: [{ customerId: 'cus_user', subscriptionId: 'sub_b', reason: 'time budget exhausted' }],
    });
    expect(mocks.subscriptionsCancel).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_a', expect.anything(), {
      timeout: 2_000,
      maxNetworkRetries: 0,
    });
    expect(mocks.voidOpenSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it('does nothing without Stripe or without a customer', async () => {
    mocks.isStripeConfigured.mockReturnValue(false);
    expect(await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger)).toEqual({
      canceled: [],
      failed: [],
    });

    mocks.isStripeConfigured.mockReturnValue(true);
    mocks.findUser.mockResolvedValue({ id: 'user-1', stripeCustomerId: null });
    expect(await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger)).toEqual({
      canceled: [],
      failed: [],
    });
    expect(mocks.subscriptionsList).not.toHaveBeenCalled();
  });

  it('reports, rather than throws, when the account cannot be read', async () => {
    mocks.findUser.mockRejectedValue(new Error('db down'));

    const result = await cancelAccountSubscriptions({ userId: 'user-1', reason: 'suspended' }, logger);

    expect(result.failed).toEqual([{ customerId: 'unknown', subscriptionId: null, reason: 'db down' }]);
  });
});
