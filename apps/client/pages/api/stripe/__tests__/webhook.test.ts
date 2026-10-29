import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

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
  postSubscriptionLifecycleToSlack: vi.fn(),
  voidOpenSubscriptionInvoices: vi.fn(),
  findUserById: vi.fn(),
  findUserByStripeCustomerId: vi.fn(),
  findByPaymentIntentId: vi.fn(),
  updateTransactionStatus: vi.fn(),
  emitBillingEvent: vi.fn(),
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
  creditTransactionRepository: {
    findByPaymentIntentId: mocks.findByPaymentIntentId,
    updateTransactionStatus: mocks.updateTransactionStatus,
  },
  organizationRepository: {},
  userRepository: { findById: mocks.findUserById, findByStripeCustomerId: mocks.findUserByStripeCustomerId },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ creditService: {}, userService: {} }));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    updateByStripeSubscriptionIdReturningBefore: mocks.updateByStripeSubscriptionId,
    markPastDue: mocks.markPastDue,
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STRIPE_WEBHOOK_SECRET: 'whsec_test' },
  isDevelopment: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ StripeEvents: {} }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  CustomerType: {},
  customerExists: vi.fn(),
  isStripeConfigured: () => true,
  stripe: { webhooks: { constructEvent: mocks.constructEvent } },
}));
vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
// The real event builders run; the post itself (stage gate, wording) is covered in subscriptionLifecycle.test.ts.
vi.mock('@server/integrations/slack/subscriptionLifecycle', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/slack/subscriptionLifecycle')>()),
  postSubscriptionLifecycleToSlack: mocks.postSubscriptionLifecycleToSlack,
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: mocks.sendToClient }));
vi.mock('@server/billing/grantCreditPurchase', () => ({ grantCreditPurchase: vi.fn() }));
vi.mock('@server/analytics/signupEvents', () => ({
  emitPurchaseEvents: vi.fn(),
  emitBillingEvent: mocks.emitBillingEvent,
}));
vi.mock('@server/billing/paymentFailureNotice', () => ({
  notifyPaymentFailed: mocks.notifyPaymentFailed,
  notifyCanceledForNonPayment: mocks.notifyCanceledForNonPayment,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' }, App: { stage: 'test' } } }));

import '@pages/api/stripe/webhook';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

/** Deliver `event` as a signed webhook. The raw body is irrelevant: constructEvent is mocked. */
const deliver = async (event: { id?: string; type: string; data: { object: Record<string, unknown> } }) => {
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

const owner = { id: 'user_1', acquisition: { firstTouch: { source: 'widgets' } } };

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
  mocks.findUserById.mockResolvedValue(owner);
  mocks.findUserByStripeCustomerId.mockResolvedValue(null);
  mocks.findByPaymentIntentId.mockResolvedValue(null);
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

  it('posts the first failed attempt to the subscriptions channel, after the row is marked', async () => {
    await deliver(failedInvoice({ attempt_count: 1, amount_due: 2000, currency: 'usd' }));

    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledWith({
      kind: 'payment_failed',
      owner: { ownerType: SubscriptionOwnerType.User, ownerId: 'user_1' },
      plan: { plan: 'unknown' },
      amountDue: { amountMinor: 2000, currency: 'usd' },
    });
    expect(mocks.markPastDue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postSubscriptionLifecycleToSlack.mock.invocationCallOrder[0]
    );
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it("does not post Stripe's later retries", async () => {
    await deliver(failedInvoice({ attempt_count: 2, amount_due: 2000, currency: 'usd' }));

    expect(mocks.postSubscriptionLifecycleToSlack).not.toHaveBeenCalled();
    expect(mocks.notifyPaymentFailed).toHaveBeenCalled();
  });

  it('does not post a first attempt for a row this stage does not own or has closed', async () => {
    mocks.markPastDue.mockResolvedValue(null);

    await deliver(failedInvoice({ attempt_count: 1, amount_due: 2000, currency: 'usd' }));

    expect(mocks.postSubscriptionLifecycleToSlack).not.toHaveBeenCalled();
  });
});

// The Stripe subscription fields stripeMirrorFields projects; every real deleted payload carries them.
const mirrorPayload = {
  customer: 'cus_1',
  currency: 'usd',
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  items: {
    data: [
      {
        price: {
          id: 'price_1',
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        },
      },
    ],
  },
};

describe('customer.subscription.deleted', () => {
  const deleted = (reason: string | null) => ({
    type: 'customer.subscription.deleted',
    data: {
      object: {
        ...mirrorPayload,
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
    expect(mocks.postSubscriptionLifecycleToSlack).not.toHaveBeenCalled();
  });

  it.each([
    ['payment_failed', 'payment_failed'],
    ['cancellation_requested', 'cancellation_requested'],
    [null, 'unknown'],
  ])('posts the end with its reason (%s) once the row is marked canceled', async (reason, expected) => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({ ...userRow, status: 'active' });

    await deliver(deleted(reason));

    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledOnce();
    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledWith({
      kind: 'ended',
      owner: { ownerType: SubscriptionOwnerType.User, ownerId: 'user_1' },
      plan: { plan: 'unknown' },
      reason: expected,
    });
    expect(mocks.updateByStripeSubscriptionId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postSubscriptionLifecycleToSlack.mock.invocationCallOrder[0]
    );
  });

  it('posts the end once across a redelivery', async () => {
    mocks.updateByStripeSubscriptionId
      .mockResolvedValueOnce({ ...userRow, status: 'active' })
      .mockResolvedValueOnce({ ...userRow, status: 'canceled' });

    await deliver(deleted('cancellation_requested'));
    await deliver(deleted('cancellation_requested'));

    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledOnce();
  });

  it('leaves the end to customer.subscription.updated when its sync reached canceled first', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({ ...userRow, status: 'canceled' });

    await deliver(deleted('payment_failed'));

    expect(mocks.postSubscriptionLifecycleToSlack).not.toHaveBeenCalled();
    expect(mocks.notifyCanceledForNonPayment).toHaveBeenCalled();
    expect(mocks.emitBillingEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'subscription_ended' }));
  });

  it("writes the subscription's final Stripe mirror with the canceled status", async () => {
    await deliver(deleted(null));

    expect(mocks.updateByStripeSubscriptionId).toHaveBeenCalledWith('sub_1', {
      status: 'canceled',
      canceledAt: new Date(1_760_000_000 * 1000),
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEndsAt: null,
      stripeCustomerId: 'cus_1',
      lastSyncedAt: expect.any(Date),
    });
  });
});

describe('billing events for Overwatch', () => {
  const sent = () => mocks.emitBillingEvent.mock.calls.map(([c]) => c);

  it('reports each failed subscription attempt, keyed on the invoice and the attempt', async () => {
    await deliver(
      failedInvoice({ amount_due: 2999, currency: 'usd', attempt_count: 2, billing_reason: 'subscription_cycle' })
    );

    expect(mocks.findUserById).toHaveBeenCalledWith('user_1');
    expect(sent()).toEqual([
      {
        user: owner,
        event: 'payment_failed',
        occurrence: 'in_1:2',
        metadata: {
          kind: 'subscription',
          value: 29.99,
          currency: 'USD',
          attempt: 2,
          billingReason: 'subscription_cycle',
        },
      },
    ]);
  });

  it("reports the value in the currency's own major unit: yen have no minor unit", async () => {
    await deliver(failedInvoice({ amount_due: 3000, currency: 'jpy', attempt_count: 1 }));
    expect(sent()[0].metadata).toMatchObject({ value: 3000, currency: 'JPY' });

    mocks.emitBillingEvent.mockClear();
    await deliver({
      id: 'evt_10',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_10',
          amount: 1500,
          currency: 'jpy',
          customer: 'cus_9',
          metadata: { environment: 'test', credits: '100' },
        },
      },
    });
    expect(sent()[0].metadata).toEqual({ kind: 'credits', value: 1500, currency: 'JPY' });
  });

  it('names no user for an organization invoice, and reports nothing with nothing due', async () => {
    mocks.markPastDue.mockResolvedValue({
      ...userRow,
      ownerType: SubscriptionOwnerType.Organization,
      ownerId: 'org_1',
    });
    await deliver(failedInvoice({ amount_due: 2999, currency: 'usd', attempt_count: 1 }));
    expect(sent()[0].user).toBeNull();
    expect(mocks.findUserById).not.toHaveBeenCalled();

    mocks.emitBillingEvent.mockClear();
    mocks.markPastDue.mockResolvedValue(userRow);
    await deliver(failedInvoice({ amount_due: 0, currency: 'usd', attempt_count: 1 }));
    expect(mocks.emitBillingEvent).not.toHaveBeenCalled();
  });

  it('reports the end of a subscription with its reason and how long it ran, keyed on the subscription', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({
      ...userRow,
      status: 'canceled',
      priceId: 'price_unknown',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      canceledAt: new Date('2026-01-31T12:00:00Z'),
    });
    // A payload without start_date or ended_at: the row's createdAt to the delivery time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));

    try {
      await deliver({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            ...mirrorPayload,
            id: 'sub_1',
            canceled_at: 1_769_860_800,
            metadata: {},
            cancellation_details: { reason: null },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(sent()).toEqual([
      {
        user: owner,
        event: 'subscription_ended',
        occurrence: 'sub_1',
        // An unrecognised price is named `unknown`, never by its Stripe id.
        metadata: { reason: 'unknown', plan: 'unknown', daysSubscribed: 30 },
      },
    ]);
  });

  it("counts a period-end cancel's days from Stripe's start to its end, not to the cancel request", async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({
      ...userRow,
      status: 'canceled',
      // The row was written well after the subscription started (a migrated or re-synced row).
      createdAt: new Date('2026-03-01T00:00:00Z'),
      canceledAt: new Date('2026-02-11T00:00:00Z'),
    });
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

    await deliver({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          ...mirrorPayload,
          id: 'sub_1',
          start_date: at('2026-01-01T00:00:00Z'),
          // Requested on Feb 11, effective at the period end on Mar 31.
          canceled_at: at('2026-02-11T00:00:00Z'),
          ended_at: at('2026-03-31T12:00:00Z'),
          metadata: {},
          cancellation_details: { reason: 'cancellation_requested' },
        },
      },
    });

    expect(sent()[0].metadata).toMatchObject({ reason: 'cancellation_requested', daysSubscribed: 89 });
  });

  it('reports nothing for a subscription this stage has no row for', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue(null);
    await deliver({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          ...mirrorPayload,
          id: 'sub_1',
          canceled_at: null,
          metadata: {},
          cancellation_details: { reason: null },
        },
      },
    });
    expect(mocks.emitBillingEvent).not.toHaveBeenCalled();
  });

  const failedIntent = (metadata: Record<string, string>) => ({
    id: 'evt_9',
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_9', amount: 999, currency: 'usd', customer: 'cus_9', metadata } },
  });

  it('reports a failed credit-pack payment, keyed on the Stripe event, though the ledger has no row', async () => {
    mocks.findUserByStripeCustomerId.mockResolvedValue(owner);

    const res = await deliver(failedIntent({ environment: 'test', credits: '100', userId: 'user_1' }));

    expect(res._getStatusCode()).toBe(200);
    expect(sent()).toEqual([
      {
        user: owner,
        event: 'payment_failed',
        occurrence: 'evt_9',
        metadata: { kind: 'credits', value: 9.99, currency: 'USD' },
      },
    ]);
  });

  it('marks the ledger row failed even when the report never settles', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_9' });
    mocks.emitBillingEvent.mockReturnValue(new Promise(() => {}));

    // Not awaited: the handler waits on the report, which here never settles.
    void deliver(failedIntent({ environment: 'test', credits: '100', userId: 'user_1' }));
    await vi.waitFor(() => expect(mocks.emitBillingEvent).toHaveBeenCalled());

    expect(mocks.updateTransactionStatus).toHaveBeenCalledWith('pi_9', 'failed');
  });

  it("ignores a subscription's payment intent and another stage's", async () => {
    await deliver(failedIntent({ environment: 'test' }));
    await deliver(failedIntent({ environment: 'production', credits: '100' }));
    expect(mocks.emitBillingEvent).not.toHaveBeenCalled();
  });
});
