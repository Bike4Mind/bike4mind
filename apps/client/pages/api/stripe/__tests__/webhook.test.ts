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
  subtractCredits: vi.fn(),
  clawbackCreditLotsByStripeRef: vi.fn(),
  forfeitSignupUnlock: vi.fn(),
  forfeitHeldUnlockForRefund: vi.fn(),
  forfeitHeldUnlockForFraudWarning: vi.fn(),
  flagDisputePending: vi.fn(),
  retrieveCharge: vi.fn(),
  updateUser: vi.fn(),
  findOrgByStripeCustomerId: vi.fn(),
  recordDisputeOpened: vi.fn(),
  recordDisputeClosed: vi.fn(),
  markDisputeUserGone: vi.fn(),
  resolveLostUserDispute: vi.fn(),
  resolveWonDispute: vi.fn(),
  recordBillingEvent: vi.fn(),
  publishSubscriptionUpdated: vi.fn(),
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
  organizationRepository: { findByStripeCustomerId: mocks.findOrgByStripeCustomerId },
  realtimeConnectionRepository: {},
  stripeDisputeRepository: {
    recordOpened: mocks.recordDisputeOpened,
    recordClosed: mocks.recordDisputeClosed,
    markUserGone: mocks.markDisputeUserGone,
  },
  userRepository: {
    findById: mocks.findUserById,
    findByStripeCustomerId: mocks.findUserByStripeCustomerId,
    update: mocks.updateUser,
  },
}));
vi.mock('@server/billing/stripeDisputes', () => ({
  disputeFacts: (dispute: { id: string }, subject: string, subjectId: string | null) => ({
    stripeDisputeId: dispute.id,
    subject,
    subjectId,
  }),
  resolveLostUserDispute: mocks.resolveLostUserDispute,
  resolveWonDispute: mocks.resolveWonDispute,
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  creditService: {
    subtractCredits: mocks.subtractCredits,
    clawbackCreditLotsByStripeRef: mocks.clawbackCreditLotsByStripeRef,
  },
  userService: { flagDisputePending: mocks.flagDisputePending },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
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
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEventSafe: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  StripeEvents: { CustomerSubscriptionUpdated: { publish: mocks.publishSubscriptionUpdated } },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  CustomerType: {},
  customerExists: vi.fn(),
  isStripeConfigured: () => true,
  stripe: { webhooks: { constructEvent: mocks.constructEvent }, charges: { retrieve: mocks.retrieveCharge } },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
// The real event builders run; the post itself (stage gate, wording) is covered in subscriptionLifecycle.test.ts.
vi.mock('@server/integrations/slack/subscriptionLifecycle', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/slack/subscriptionLifecycle')>()),
  postSubscriptionLifecycleToSlack: mocks.postSubscriptionLifecycleToSlack,
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: mocks.sendToClient }));
vi.mock('@server/billing/grantCreditPurchase', () => ({ grantCreditPurchase: vi.fn() }));
vi.mock('@server/credits/paymentUnlockForfeit', () => ({
  forfeitSignupUnlock: mocks.forfeitSignupUnlock,
  forfeitHeldUnlockForRefund: mocks.forfeitHeldUnlockForRefund,
  forfeitHeldUnlockForFraudWarning: mocks.forfeitHeldUnlockForFraudWarning,
}));

// Payment risk screening has its own suite (server/billing/paymentRisk.test.ts).
vi.mock('@server/billing/paymentRisk', () => ({
  alertStripeRiskEvent: vi.fn(),
  radarRiskLine: vi.fn().mockResolvedValue(null),
  screenPaymentOutcome: vi.fn(),
}));
vi.mock('@server/billing/earlyFraudWarning', () => ({ respondToEarlyFraudWarning: vi.fn() }));
vi.mock('@server/billing/linkedAccounts', () => ({ propagateAccountRisk: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({
  emitPurchaseEvents: vi.fn(),
  emitBillingEvent: mocks.emitBillingEvent,
}));
const { reverseReward } = vi.hoisted(() => ({ reverseReward: vi.fn() }));
vi.mock('@bike4mind/server-utils/referrals/subscriptionReward', () => ({ reverseSubscriptionRewardForRefund: reverseReward }));
const { reverseStanding } = vi.hoisted(() => ({ reverseStanding: vi.fn() }));
vi.mock('@server/billing/purchaseReversal', () => ({ reversePurchaseStanding: reverseStanding }));
vi.mock('@server/billing/paymentFailureNotice', () => ({
  notifyPaymentFailed: mocks.notifyPaymentFailed,
  notifyCanceledForNonPayment: mocks.notifyCanceledForNonPayment,
}));
// The store itself (stage check, owner, projection) is covered in server/billing/billingEventStore.test.ts.
vi.mock('@server/billing/billingEventStore', () => ({ recordBillingEvent: mocks.recordBillingEvent }));
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
  mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: 0 });
  mocks.findOrgByStripeCustomerId.mockResolvedValue(null);
  mocks.recordDisputeClosed.mockImplementation(async (facts: object) => ({ ...facts, state: 'open' }));
});

describe('signup unlock forfeits', () => {
  it('forfeits the signup unlock of a disputed subscription payer found by customer', async () => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_1', customer: 'cus_1' });
    mocks.findUserByStripeCustomerId.mockResolvedValue(owner);

    const res = await deliver({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 3000, currency: 'usd', reason: 'fraudulent' } },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.forfeitSignupUnlock).toHaveBeenCalledWith('user_1', 'dispute', logger);
  });

  it('forfeits on a refunded charge before its credit purchase lookup', async () => {
    const charge = { id: 'ch_1', customer: 'cus_1', payment_intent: 'pi_1', refunds: { data: [{ id: 're_1' }] } };

    await deliver({ type: 'charge.refunded', data: { object: charge } });

    expect(mocks.forfeitHeldUnlockForRefund).toHaveBeenCalledExactlyOnceWith(charge, logger);
  });

  it('forfeits on a refunded charge that carries no refund list', async () => {
    const charge = { id: 'ch_1', customer: 'cus_1', payment_intent: 'pi_1' };

    await deliver({ type: 'charge.refunded', data: { object: charge } });

    expect(mocks.forfeitHeldUnlockForRefund).toHaveBeenCalledExactlyOnceWith(charge, logger);
  });

  // Guards a merge with another radar.early_fraud_warning.created case dropping this call.
  it('cancels a held unlock on an early fraud warning', async () => {
    const warning = { id: 'issfr_1', charge: 'ch_1' };

    const res = await deliver({ type: 'radar.early_fraud_warning.created', data: { object: warning } });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.forfeitHeldUnlockForFraudWarning).toHaveBeenCalledExactlyOnceWith(warning, logger);
  });
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
    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledWith(
      {
        kind: 'ended',
        owner: { ownerType: SubscriptionOwnerType.User, ownerId: 'user_1' },
        plan: { plan: 'unknown' },
        reason: expected,
      },
      { timeoutMs: 3_000 }
    );
    expect(mocks.updateByStripeSubscriptionId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postSubscriptionLifecycleToSlack.mock.invocationCallOrder[0]
    );
  });

  it('posts the end before the invoice cleanup, so a delivery that times out in it has still posted', async () => {
    mocks.updateByStripeSubscriptionId.mockResolvedValue({ ...userRow, status: 'active' });
    mocks.voidOpenSubscriptionInvoices.mockReturnValueOnce(new Promise(() => {}));

    // Not awaited: the handler waits on the cleanup, which here never settles.
    void deliver(deleted('cancellation_requested'));
    await vi.waitFor(() => expect(mocks.voidOpenSubscriptionInvoices).toHaveBeenCalled());

    expect(mocks.postSubscriptionLifecycleToSlack).toHaveBeenCalledOnce();
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

describe('charge.refunded - inviter reward', () => {
  const refundedCharge = (overrides: Record<string, unknown> = {}) => ({
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_1',
        amount: 3000,
        amount_captured: 3000,
        amount_refunded: 1500,
        payment_intent: 'pi_1',
        refunds: { data: [{ id: 're_1', amount: 1500 }] },
        ...overrides,
      },
    },
  });

  it('hands the payment and the cumulative refunded amount to the inviter reward, even with no credit row', async () => {
    const res = await deliver(refundedCharge());

    expect(res._getStatusCode()).toBe(200);
    expect(reverseReward).toHaveBeenCalledExactlyOnceWith({
      paymentIntentId: 'pi_1',
      amountRefunded: 1500,
      amountCaptured: 3000,
    });
  });

  it('falls back to the charge amount when nothing was captured', async () => {
    await deliver(refundedCharge({ amount_captured: 0 }));
    expect(reverseReward).toHaveBeenCalledWith(expect.objectContaining({ amountCaptured: 3000 }));
  });

  it('reverses the purchase standing only once the whole charge is refunded', async () => {
    await deliver(refundedCharge({ refunded: false }));
    expect(reverseStanding).not.toHaveBeenCalled();

    await deliver(refundedCharge({ refunded: true, amount_refunded: 3000 }));
    expect(reverseStanding).toHaveBeenCalledExactlyOnceWith({ paymentIntentId: 'pi_1', reason: 'refunded' }, logger);
  });

  it('still runs the payer-side refund steps when the standing reversal fails, then fails the event', async () => {
    reverseStanding.mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(refundedCharge({ refunded: true }))).rejects.toThrow('mongo down');
    expect(mocks.findByPaymentIntentId).toHaveBeenCalledWith('pi_1');
  });

  it('leaves the reward alone when the charge has no payment intent', async () => {
    await deliver(refundedCharge({ payment_intent: null }));
    expect(reverseReward).not.toHaveBeenCalled();
  });

  it('runs the payer-side refund steps and still fails the event when the reward take-back fails persistently', async () => {
    reverseReward.mockRejectedValueOnce(new Error('mongo down')).mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(refundedCharge())).rejects.toThrow('mongo down');
    expect(mocks.findByPaymentIntentId).toHaveBeenCalledWith('pi_1');

    await expect(deliver(refundedCharge())).rejects.toThrow('mongo down');
    expect(reverseReward).toHaveBeenCalledTimes(2);
  });

  it('applies the reward take-back on the redelivery after a transient failure', async () => {
    reverseReward.mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(refundedCharge())).rejects.toThrow('mongo down');

    const res = await deliver(refundedCharge());
    expect(res._getStatusCode()).toBe(200);
    expect(reverseReward).toHaveBeenCalledTimes(2);
  });

  it('still hands the refund to the inviter reward when the charge carries no refund list', async () => {
    await deliver(refundedCharge({ refunds: undefined }));
    await deliver(refundedCharge({ refunds: { data: [] } }));
    expect(reverseReward).toHaveBeenCalledTimes(2);
    expect(reverseReward).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountRefunded: 1500, amountCaptured: 3000 });
  });
});

describe('charge.dispute.created - inviter reward', () => {
  const dispute = (overrides: Record<string, unknown> = {}) => ({
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_1',
        amount: 3000,
        currency: 'usd',
        reason: 'fraudulent',
        payment_intent: 'pi_1',
        charge: null,
        ...overrides,
      },
    },
  });

  it('reverses the inviter reward as a full refund before the payer clawback runs', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: false });
    const res = await deliver(dispute());

    expect(res._getStatusCode()).toBe(200);
    expect(reverseReward).toHaveBeenCalledExactlyOnceWith({
      paymentIntentId: 'pi_1',
      amountRefunded: 3000,
      amountCaptured: 3000,
      reason: 'disputed',
    });
    expect(mocks.subtractCredits).toHaveBeenCalledOnce();
    expect(reverseReward.mock.invocationCallOrder[0]).toBeLessThan(mocks.subtractCredits.mock.invocationCallOrder[0]);
  });

  it('leaves the reward alone when the dispute has no payment intent', async () => {
    await deliver(dispute({ payment_intent: null }));
    expect(reverseReward).not.toHaveBeenCalled();
  });

  it('runs the payer clawback and still fails the event when the reward reversal fails persistently', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: false });
    reverseReward.mockRejectedValueOnce(new Error('mongo down')).mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(dispute())).rejects.toThrow('mongo down');
    expect(mocks.subtractCredits).toHaveBeenCalledOnce();
    expect(mocks.flagDisputePending).toHaveBeenCalledOnce();

    await expect(deliver(dispute())).rejects.toThrow('mongo down');
    expect(reverseReward).toHaveBeenCalledTimes(2);
  });

  it('applies the reversal on the redelivery after a transient failure', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: false });
    reverseReward.mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(dispute())).rejects.toThrow('mongo down');

    const res = await deliver(dispute());
    expect(res._getStatusCode()).toBe(200);
    expect(reverseReward).toHaveBeenCalledTimes(2);
  });
});

describe('charge.dispute.closed', () => {
  // Stripe fixture: a closed dispute paid by customer cus_1.
  const closed = (status: string) => ({
    type: 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_1',
        status,
        amount: 3000,
        currency: 'usd',
        reason: 'fraudulent',
        created: 1_790_000_000,
        payment_intent: 'pi_1',
        charge: 'ch_1',
      },
    },
  });
  const contained = {
    status: 'contained',
    item: { contain: { suspended: true, creditDelta: -500, apiKeysRevoked: 2 } },
  };

  beforeEach(() => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_1', customer: 'cus_1' });
  });

  it('resolves a lost user dispute with a Contain and keeps the dispute flag', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.resolveLostUserDispute.mockResolvedValue(contained);

    const res = await deliver(closed('lost'));

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.recordDisputeClosed).toHaveBeenCalledWith(
      { stripeDisputeId: 'dp_1', subject: 'user', subjectId: 'user_1' },
      expect.any(Date)
    );
    expect(mocks.resolveLostUserDispute).toHaveBeenCalledWith(
      expect.objectContaining({ stripeDisputeId: 'dp_1', state: 'open' }),
      owner,
      logger
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'Dispute flag kept. Account contained: suspended, 500 credits removed, 2 API key(s) revoked.'
      )
    );
  });

  it('stays quiet when a redelivered close finds the dispute already resolved', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.resolveLostUserDispute.mockResolvedValue({ status: 'already_resolved' });

    await deliver(closed('lost'));

    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('alerts and warns when an admin resolved the dispute before the lost close arrived', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.recordDisputeClosed.mockImplementation(async (facts: object) => ({
      ...facts,
      state: 'resolved',
      resolution: { outcome: 'admin' },
    }));
    mocks.resolveLostUserDispute.mockResolvedValue({ status: 'already_resolved' });

    const res = await deliver(closed('lost'));

    expect(res._getStatusCode()).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resolved by an admin first'));
    expect(mocks.postMessageToSlack).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('An admin resolved this dispute before the close arrived')
    );
  });

  it('does not contain when the record names a different user than the close found', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.recordDisputeClosed.mockImplementation(async (facts: object) => ({
      ...facts,
      subject: 'user',
      subjectId: 'user_other',
      state: 'open',
    }));

    const res = await deliver(closed('lost'));

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('names a different user'));
    expect(mocks.postMessageToSlack).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('The record names a different account')
    );
  });

  it('fails the delivery when the Contain throws, so Stripe retries it', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.resolveLostUserDispute.mockRejectedValue(new Error('contain failed'));

    await expect(deliver(closed('lost'))).rejects.toThrow('contain failed');
  });

  it('queues a lost organization dispute for an admin without containing anyone', async () => {
    mocks.findOrgByStripeCustomerId.mockResolvedValue({ id: 'org_1' });

    await deliver(closed('lost'));

    expect(mocks.recordDisputeClosed).toHaveBeenCalledWith(
      { stripeDisputeId: 'dp_1', subject: 'organization', subjectId: 'org_1' },
      expect.any(Date)
    );
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('Resolve it in Admin > Disputes.'));
  });

  it('does not post a redelivered lost organization close to Slack again', async () => {
    mocks.findOrgByStripeCustomerId.mockResolvedValue({ id: 'org_1' });
    mocks.recordDisputeClosed.mockImplementation(async (facts: object) => ({
      ...facts,
      state: 'open',
      redelivered: true,
    }));

    await deliver(closed('lost'));

    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('re-files a lost dispute whose user is gone as unmatched so an admin can resolve it', async () => {
    mocks.recordDisputeClosed.mockResolvedValue({ stripeDisputeId: 'dp_1', subject: 'user', state: 'open' });

    await deliver(closed('lost'));

    expect(mocks.markDisputeUserGone).toHaveBeenCalledExactlyOnceWith('dp_1');
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
  });

  it('records a lost dispute with no matching account as unmatched', async () => {
    await deliver(closed('lost'));

    expect(mocks.recordDisputeClosed).toHaveBeenCalledWith(
      { stripeDisputeId: 'dp_1', subject: 'unmatched', subjectId: null },
      expect.any(Date)
    );
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
  });

  it('clears the dispute flag only on a won dispute, and resolves its record', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });

    await deliver(closed('won'));

    expect(mocks.updateUser).toHaveBeenCalledExactlyOnceWith({ id: 'user_1', disputePending: false });
    expect(mocks.resolveWonDispute).toHaveBeenCalledWith('dp_1', logger);
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
  });

  it('records any other closing status for an admin and takes no account action', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });

    await deliver(closed('warning_closed'));

    expect(mocks.recordDisputeClosed).toHaveBeenCalledWith(
      { stripeDisputeId: 'dp_1', subject: 'user', subjectId: 'user_1' },
      expect.any(Date)
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.resolveLostUserDispute).not.toHaveBeenCalled();
    expect(mocks.resolveWonDispute).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });
});

describe('charge.dispute.created - dispute record', () => {
  it('records a user dispute against the matched account', async () => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_1', customer: 'cus_1' });
    mocks.findUserByStripeCustomerId.mockResolvedValue(owner);

    await deliver({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 3000, currency: 'usd', reason: 'fraudulent' } },
    });

    expect(mocks.recordDisputeOpened).toHaveBeenCalledExactlyOnceWith({
      stripeDisputeId: 'dp_1',
      subject: 'user',
      subjectId: 'user_1',
    });
  });

  it('records a dispute with no matching account as unmatched', async () => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_1', customer: 'cus_1' });

    await deliver({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 3000, currency: 'usd', reason: 'fraudulent' } },
    });

    expect(mocks.recordDisputeOpened).toHaveBeenCalledExactlyOnceWith({
      stripeDisputeId: 'dp_1',
      subject: 'unmatched',
      subjectId: null,
    });
  });

  it('records an organization dispute for the admin queue', async () => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_1', customer: 'cus_1' });
    mocks.findOrgByStripeCustomerId.mockResolvedValue({ id: 'org_1' });

    await deliver({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 3000, currency: 'usd', reason: 'fraudulent' } },
    });

    expect(mocks.recordDisputeOpened).toHaveBeenCalledExactlyOnceWith({
      stripeDisputeId: 'dp_1',
      subject: 'organization',
      subjectId: 'org_1',
    });
  });
});

describe('BillingEvent recording', () => {
  const dispute = {
    id: 'evt_dispute_1',
    type: 'charge.dispute.created',
    data: {
      object: { id: 'dp_1', amount: 3000, currency: 'usd', reason: 'fraudulent', payment_intent: 'pi_1', charge: null },
    },
  };

  beforeEach(() => {
    mocks.findByPaymentIntentId.mockResolvedValue({ id: 'tx_1', ownerId: 'user_1', credits: 50000 });
    mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: false });
  });

  it('records the event after its side effects, with the owner the handler resolved', async () => {
    const res = await deliver(dispute);

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.recordBillingEvent).toHaveBeenCalledExactlyOnceWith(
      dispute,
      { owner: { ownerType: 'user', ownerId: 'user_1' } },
      logger
    );
    expect(mocks.subtractCredits.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordBillingEvent.mock.invocationCallOrder[0]
    );
    expect(mocks.flagDisputePending.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordBillingEvent.mock.invocationCallOrder[0]
    );
  });

  it('records nothing and fails the delivery when a side effect fails, so the redelivery re-runs it', async () => {
    mocks.subtractCredits.mockRejectedValueOnce(new Error('mongo down'));

    await expect(deliver(dispute)).rejects.toThrow('mongo down');
    expect(mocks.recordBillingEvent).not.toHaveBeenCalled();

    const res = await deliver(dispute);
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.subtractCredits).toHaveBeenCalledTimes(2);
    expect(mocks.recordBillingEvent).toHaveBeenCalledOnce();
  });

  it('re-runs a replay under the per-entity key, which dedupes the clawback, and hands the same event id to the store', async () => {
    await deliver(dispute);
    mocks.subtractCredits.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

    const res = await deliver(dispute);

    expect(res._getStatusCode()).toBe(200);
    // The duplicate-key clawback is a no-op, so the lot clawback that follows it runs only once.
    expect(mocks.clawbackCreditLotsByStripeRef).toHaveBeenCalledOnce();
    expect(mocks.recordBillingEvent).toHaveBeenCalledTimes(2);
    expect(mocks.recordBillingEvent.mock.calls.map(([event]) => event.id)).toEqual(['evt_dispute_1', 'evt_dispute_1']);
  });

  it('records a worker-handled event once its publish succeeded, and not when the publish fails', async () => {
    const updated = {
      id: 'evt_upd_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', object: 'subscription' } },
    };

    await deliver(updated);
    expect(mocks.publishSubscriptionUpdated).toHaveBeenCalledWith({ subscriptionId: 'sub_1' });
    expect(mocks.recordBillingEvent).toHaveBeenCalledExactlyOnceWith(updated, {}, logger);

    mocks.publishSubscriptionUpdated.mockRejectedValueOnce(new Error('bus down'));
    await expect(deliver(updated)).rejects.toThrow('bus down');
    expect(mocks.recordBillingEvent).toHaveBeenCalledOnce();
  });

  it.each([
    'invoice.paid',
    'invoice.finalized',
    'customer.subscription.trial_will_end',
    'customer.subscription.created',
  ])('hands an unhandled %s to the store and does nothing else', async type => {
    const event = { id: 'evt_x', type, data: { object: { id: 'in_1', object: 'invoice' } } };

    const res = await deliver(event);

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.recordBillingEvent).toHaveBeenCalledExactlyOnceWith(event, {}, logger);
    expect(mocks.markPastDue).not.toHaveBeenCalled();
    expect(mocks.updateByStripeSubscriptionId).not.toHaveBeenCalled();
    expect(mocks.publishSubscriptionUpdated).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('marks a payment failure whose dunning email this delivery sent', async () => {
    mocks.notifyPaymentFailed.mockResolvedValueOnce(true);

    await deliver(failedInvoice());

    expect(mocks.recordBillingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.payment_failed' }),
      { data: { dunningNoticeSent: true } },
      logger
    );
  });
});
