import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { ISubscription, SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const mocks = vi.hoisted(() => ({
  findOrg: vi.fn(),
  findUser: vi.fn(),
  retrieveInvoice: vi.fn(),
  publish: vi.fn(),
  claimFailure: vi.fn(),
  releaseFailure: vi.fn(),
  claimCancel: vi.fn(),
  releaseCancel: vi.fn(),
  emitMetric: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findOrg },
  userRepository: { findById: mocks.findUser },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { invoices: { retrieve: mocks.retrieveInvoice } },
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: mocks.emitMetric }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mocks.publish } } }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    claimPaymentFailureNotice: mocks.claimFailure,
    releasePaymentFailureNotice: mocks.releaseFailure,
    claimNonPaymentCancelNotice: mocks.claimCancel,
    releaseNonPaymentCancelNotice: mocks.releaseCancel,
  },
}));

import {
  getInvoiceFailureReason,
  notifyCanceledForNonPayment,
  notifyPaymentFailed,
  resolveOwnerRecipient,
} from './paymentFailureNotice';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const userSub = {
  ownerType: SubscriptionOwnerType.User,
  ownerId: 'user_1',
  subscriptionId: 'sub_1',
} as ISubscription;

const orgSub = {
  ownerType: SubscriptionOwnerType.Organization,
  ownerId: 'org_1',
  subscriptionId: 'sub_org',
} as ISubscription;

const invoice = { id: 'in_1', next_payment_attempt: null, billing_reason: 'subscription_cycle' as const };

const invoiceWithPayments = (payments: Array<{ created: number; message?: string }>) => ({
  payments: {
    data: payments.map(p => ({
      created: p.created,
      payment: { payment_intent: { last_payment_error: p.message ? { message: p.message } : null } },
    })),
  },
});

const originalAppUrl = process.env.APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://app.example.com';
  mocks.findUser.mockImplementation(async (id: string) => ({ id, email: `${id}@example.com` }));
  mocks.findOrg.mockResolvedValue({ id: 'org_1', name: 'Team', userId: 'owner_1' });
  mocks.retrieveInvoice.mockResolvedValue(invoiceWithPayments([]));
  mocks.claimFailure.mockResolvedValue(true);
  mocks.claimCancel.mockResolvedValue(true);
  mocks.publish.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env.APP_URL = originalAppUrl;
});

describe('resolveOwnerRecipient', () => {
  it('sends a personal subscription to its user, linking the plans deep link', async () => {
    await expect(resolveOwnerRecipient(userSub)).resolves.toEqual({
      email: 'user_1@example.com',
      organizationName: null,
      billingUrl: 'https://app.example.com/billing/plans',
    });
  });

  it('sends an org subscription to the org owner, linking the org Billing tab', async () => {
    await expect(resolveOwnerRecipient(orgSub)).resolves.toEqual({
      email: 'owner_1@example.com',
      organizationName: 'Team',
      billingUrl: 'https://app.example.com/organizations/org_1?tab=billing',
    });
    expect(mocks.findUser).toHaveBeenCalledWith('owner_1');
  });

  it('returns null when the owner has no email', async () => {
    mocks.findUser.mockResolvedValue({ id: 'user_1', email: null });

    await expect(resolveOwnerRecipient(userSub)).resolves.toBeNull();
  });
});

describe('getInvoiceFailureReason', () => {
  it("returns the latest payment's error message", async () => {
    mocks.retrieveInvoice.mockResolvedValue(
      invoiceWithPayments([
        { created: 100, message: 'Old decline' },
        { created: 200, message: 'Your card has insufficient funds.' },
      ])
    );

    await expect(getInvoiceFailureReason('in_1', logger)).resolves.toBe('Your card has insufficient funds.');
  });

  it('returns null instead of throwing when Stripe is unreachable', async () => {
    mocks.retrieveInvoice.mockRejectedValue(new Error('network'));

    await expect(getInvoiceFailureReason('in_1', logger)).resolves.toBeNull();
  });
});

describe('notifyPaymentFailed', () => {
  it('claims the invoice and publishes one email to the owner', async () => {
    await notifyPaymentFailed(userSub, invoice, logger);

    expect(mocks.claimFailure).toHaveBeenCalledWith('sub_1', 'in_1');
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0].to).toBe('user_1@example.com');
  });

  it.each(['subscription_update', 'subscription_create', 'manual'] as const)(
    'sends nothing for a %s invoice, which is not a renewal',
    async billingReason => {
      await notifyPaymentFailed(userSub, { ...invoice, billing_reason: billingReason }, logger);

      expect(mocks.claimFailure).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    }
  );

  it('stops at the claim for an invoice already emailed, before any lookup', async () => {
    mocks.claimFailure.mockResolvedValue(false);

    await notifyPaymentFailed(userSub, invoice, logger);

    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.retrieveInvoice).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('never throws when publishing fails, and releases the claim for the next retry', async () => {
    mocks.publish.mockRejectedValue(new Error('event bus down'));

    await expect(notifyPaymentFailed(userSub, invoice, logger)).resolves.toBeUndefined();
    expect(mocks.releaseFailure).toHaveBeenCalledWith('sub_1', 'in_1');
    expect(mocks.emitMetric).toHaveBeenCalledWith('Lumina5/Billing', 'BillingNoticeFailed', 1, {
      kind: 'payment_failed',
    });
  });

  it('never throws when APP_URL is unset', async () => {
    delete process.env.APP_URL;

    await expect(notifyPaymentFailed(userSub, invoice, logger)).resolves.toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.releaseFailure).toHaveBeenCalledWith('sub_1', 'in_1');
  });

  it('keeps the original failure logged when the release also fails', async () => {
    mocks.publish.mockRejectedValue(new Error('event bus down'));
    mocks.releaseFailure.mockRejectedValue(new Error('mongo blip'));

    await expect(notifyPaymentFailed(userSub, invoice, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send'), {
      error: expect.objectContaining({ message: 'event bus down' }),
    });
  });

  it('never throws and releases nothing when the claim itself fails', async () => {
    mocks.claimFailure.mockRejectedValue(new Error('mongo down'));

    await expect(notifyPaymentFailed(userSub, invoice, logger)).resolves.toBeUndefined();
    expect(mocks.releaseFailure).not.toHaveBeenCalled();
  });

  it('keeps the claim when there is no one to email', async () => {
    mocks.findUser.mockResolvedValue(null);

    await notifyPaymentFailed(userSub, invoice, logger);

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.releaseFailure).not.toHaveBeenCalled();
  });
});

describe('notifyCanceledForNonPayment', () => {
  it('publishes once under the cancel claim', async () => {
    await notifyCanceledForNonPayment(orgSub, logger);

    expect(mocks.claimCancel).toHaveBeenCalledWith('sub_org');
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0].to).toBe('owner_1@example.com');
  });

  it('sends nothing on a redelivery', async () => {
    mocks.claimCancel.mockResolvedValue(false);

    await notifyCanceledForNonPayment(orgSub, logger);

    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('never throws when publishing fails', async () => {
    mocks.publish.mockRejectedValue(new Error('event bus down'));

    await expect(notifyCanceledForNonPayment(orgSub, logger)).resolves.toBeUndefined();
    expect(mocks.releaseCancel).toHaveBeenCalledWith('sub_org');
  });
});
