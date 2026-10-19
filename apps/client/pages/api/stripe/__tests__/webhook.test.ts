import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

/**
 * Route-level cover for the dunning branches of the Stripe webhook: who gets the payment-failed
 * and cancelled-for-non-payment emails, and when a stage must stay silent. The notices
 * themselves (claims, recipient, copy) are covered in server/billing/paymentFailureNotice.test.ts.
 */

const mocks = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  constructEvent: vi.fn(),
  updateByStripeSubscriptionId: vi.fn(),
  markPastDue: vi.fn(),
  notifyPaymentFailed: vi.fn(),
  notifyCanceledForNonPayment: vi.fn(),
  sendToClient: vi.fn(),
  postMessageToSlack: vi.fn(),
  voidOpenSubscriptionInvoices: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      mocks.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ creditService: {}, userService: {} }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    updateByStripeSubscriptionId: mocks.updateByStripeSubscriptionId,
    markPastDue: mocks.markPastDue,
  },
}));
vi.mock('@server/utils/config', () => ({
  Config: { STRIPE_WEBHOOK_SECRET: 'whsec_test' },
  isDevelopment: () => false,
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ StripeEvents: {} }));
vi.mock('@server/integrations/stripe/stripe', () => ({
  CustomerType: {},
  customerExists: vi.fn(),
  isStripeConfigured: () => true,
  stripe: { webhooks: { constructEvent: mocks.constructEvent } },
}));
vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: mocks.sendToClient }));
vi.mock('@server/billing/grantCreditPurchase', () => ({ grantCreditPurchase: vi.fn() }));
vi.mock('@server/analytics/signupEvents', () => ({ emitPurchaseForSourceProducts: vi.fn() }));
vi.mock('@server/billing/paymentFailureNotice', () => ({
  notifyPaymentFailed: mocks.notifyPaymentFailed,
  notifyCanceledForNonPayment: mocks.notifyCanceledForNonPayment,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));

import '@pages/api/stripe/webhook';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

/** Deliver `event` as a signed webhook. The raw body is irrelevant: constructEvent is mocked. */
const deliver = async (event: { type: string; data: { object: Record<string, unknown> } }) => {
  mocks.constructEvent.mockReturnValue(event);
  const { res } = createMocks();
  const req = {
    headers: { 'stripe-signature': 'sig' },
    logger,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}');
    },
  };
  await mocks.postHandler!(req, res);
  return res;
};

const userRow = {
  ownerType: SubscriptionOwnerType.User,
  ownerId: 'user_1',
  subscriptionId: 'sub_1',
  status: 'past_due',
};

const failedInvoice = (overrides: Record<string, unknown> = {}) => ({
  type: 'invoice.payment_failed',
  data: {
    object: {
      id: 'in_1',
      next_payment_attempt: null,
      parent: { subscription_details: { subscription: 'sub_1' } },
      metadata: {},
      ...overrides,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateByStripeSubscriptionId.mockResolvedValue(userRow);
  mocks.markPastDue.mockResolvedValue(userRow);
  mocks.voidOpenSubscriptionInvoices.mockResolvedValue({ voided: [], failed: [] });
});

describe('invoice.payment_failed', () => {
  it('marks the row past_due and emails its owner', async () => {
    const res = await deliver(failedInvoice());

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.markPastDue).toHaveBeenCalledWith('sub_1');
    expect(mocks.notifyPaymentFailed).toHaveBeenCalledWith(userRow, expect.objectContaining({ id: 'in_1' }), logger);
  });

  it("refreshes a personal owner's client from the row, not the never-set invoice metadata", async () => {
    await deliver(failedInvoice());

    expect(mocks.sendToClient).toHaveBeenCalledWith('user_1', 'wss://test', expect.anything());
  });

  it('does not refresh a client for an org-owned subscription', async () => {
    mocks.markPastDue.mockResolvedValue({
      ...userRow,
      ownerType: SubscriptionOwnerType.Organization,
      ownerId: 'org_1',
    });

    await deliver(failedInvoice());

    expect(mocks.sendToClient).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentFailed).toHaveBeenCalled();
  });

  // markPastDue is null both for no row in this stage and for a row already closed (a late
  // delivery after customer.subscription.deleted); Subscription.e2e.test.ts pins the latter.
  it('stays silent when markPastDue finds no open row', async () => {
    mocks.markPastDue.mockResolvedValue(null);

    const res = await deliver(failedInvoice());

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.notifyPaymentFailed).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('ignores an invoice with no subscription', async () => {
    await deliver(failedInvoice({ parent: null }));

    expect(mocks.markPastDue).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentFailed).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.deleted', () => {
  const deleted = (reason: string | null) => ({
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_1',
        canceled_at: 1_760_000_000,
        metadata: {},
        cancellation_details: { reason },
      },
    },
  });

  it('sends the final notice when dunning cancelled the subscription', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({ ...userRow, status: 'canceled' });

    await deliver(deleted('payment_failed'));

    expect(mocks.notifyCanceledForNonPayment).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1' }),
      logger
    );
  });

  it('sends nothing when the customer cancelled', async () => {
    await deliver(deleted('cancellation_requested'));

    expect(mocks.notifyCanceledForNonPayment).not.toHaveBeenCalled();
  });

  it('sends nothing in a stage with no row for the subscription', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue(null);

    await deliver(deleted('payment_failed'));

    expect(mocks.notifyCanceledForNonPayment).not.toHaveBeenCalled();
  });
});
