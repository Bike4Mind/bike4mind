import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  findById: vi.fn(),
  findByStripeCustomerId: vi.fn(),
  findByPaymentIntentId: vi.fn(),
  isCompleted: vi.fn(),
  claimStep: vi.fn(),
  markCompleted: vi.fn(),
  chargesRetrieve: vi.fn(),
  refundsCreate: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  subscriptionsCancel: vi.fn(),
  findNonTerminalSubscriptionsByOwner: vi.fn(),
  voidOpenSubscriptionInvoices: vi.fn(),
  subtractCredits: vi.fn(),
  clawbackRefundCredits: vi.fn(),
  lockAccountForPaymentRisk: vi.fn(),
  propagateAccountRisk: vi.fn(),
  alertStripeRiskEvent: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditTransactionRepository: { findByPaymentIntentId: mocks.findByPaymentIntentId },
  userRepository: { findById: mocks.findById, findByStripeCustomerId: mocks.findByStripeCustomerId },
  paymentRiskActionRepository: {
    isCompleted: mocks.isCompleted,
    claimStep: mocks.claimStep,
    markCompleted: mocks.markCompleted,
  },
}));
vi.mock('@bike4mind/services', () => ({ creditService: { subtractCredits: mocks.subtractCredits } }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    charges: { retrieve: mocks.chargesRetrieve },
    refunds: { create: mocks.refundsCreate },
    subscriptions: { retrieve: mocks.subscriptionsRetrieve, cancel: mocks.subscriptionsCancel },
  },
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findNonTerminalSubscriptionsByOwner: mocks.findNonTerminalSubscriptionsByOwner },
}));
vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: mocks.voidOpenSubscriptionInvoices,
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('@server/billing/refundClawback', () => ({ clawbackRefundCredits: mocks.clawbackRefundCredits }));
vi.mock('@server/billing/linkedAccounts', () => ({
  lockAccountForPaymentRisk: mocks.lockAccountForPaymentRisk,
  propagateAccountRisk: mocks.propagateAccountRisk,
}));
vi.mock('@server/billing/paymentRisk', async importOriginal => ({
  ...(await importOriginal<typeof import('./paymentRisk')>()),
  alertStripeRiskEvent: mocks.alertStripeRiskEvent,
}));

import { respondToEarlyFraudWarning, shouldRefund, unspentPercent } from './earlyFraudWarning';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const charge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge =>
  ({
    id: 'ch_1',
    amount: 10000,
    amount_captured: 10000,
    amount_refunded: 0,
    refunded: false,
    currency: 'usd',
    customer: 'cus_1',
    payment_intent: 'pi_1',
    payment_method_details: { card: { fingerprint: 'fp_1' } },
    outcome: { risk_level: 'elevated', risk_score: 70, type: 'authorized', reason: null },
    ...overrides,
  }) as unknown as Stripe.Charge;

const warningEvent = {
  type: 'radar.early_fraud_warning.created',
  data: {
    object: { id: 'issfr_1', charge: 'ch_1', payment_intent: 'pi_1', fraud_type: 'unauthorized_use_of_card' },
  },
} as unknown as Stripe.RadarEarlyFraudWarningCreatedEvent;

const user = { id: 'u1', currentCredits: 150_000, disputePending: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.isCompleted.mockResolvedValue(false);
  mocks.claimStep.mockResolvedValue(true);
  mocks.chargesRetrieve.mockResolvedValue(charge());
  mocks.findByPaymentIntentId.mockResolvedValue({ ownerId: 'u1', credits: 166_667 });
  mocks.findById.mockResolvedValue(user);
  mocks.refundsCreate.mockResolvedValue({ id: 're_1', amount: 10000, currency: 'usd' });
  mocks.clawbackRefundCredits.mockResolvedValue({ credits: 166_667, ratio: 1 });
  mocks.lockAccountForPaymentRisk.mockResolvedValue({ deactivatedKeys: true });
  mocks.findNonTerminalSubscriptionsByOwner.mockResolvedValue([]);
  mocks.propagateAccountRisk.mockResolvedValue({ locked: ['u2'], review: [] });
});

describe('unspentPercent / shouldRefund', () => {
  it('measures the balance against the purchase, clamped to 0..100', () => {
    expect(unspentPercent(50, 100)).toBe(50);
    expect(unspentPercent(500, 100)).toBe(100);
    expect(unspentPercent(-20, 100)).toBe(0);
    expect(unspentPercent(50, null)).toBeNull();
  });

  it('always refunds at 0 or for an unknown purchase, otherwise only at or above the threshold', () => {
    expect(shouldRefund(10, 0)).toBe(true);
    expect(shouldRefund(null, 80)).toBe(true);
    expect(shouldRefund(79, 80)).toBe(false);
    expect(shouldRefund(80, 80)).toBe(true);
  });
});

describe('respondToEarlyFraudWarning', () => {
  it('refunds, claws back, locks, propagates and alerts once with what it did', async () => {
    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.refundsCreate).toHaveBeenCalledWith(
      { charge: 'ch_1', amount: 10000, reason: 'fraudulent', metadata: { earlyFraudWarningId: 'issfr_1' } },
      { idempotencyKey: 'efw-refund:issfr_1' }
    );
    expect(mocks.clawbackRefundCredits).toHaveBeenCalledWith({
      userId: 'u1',
      paymentIntentId: 'pi_1',
      purchasedCredits: 166_667,
      chargeAmount: 10000,
      refund: { id: 're_1', amount: 10000 },
    });
    expect(mocks.lockAccountForPaymentRisk).toHaveBeenCalledWith(user);
    expect(mocks.propagateAccountRisk).toHaveBeenCalledWith(
      { sourceUserId: 'u1', trigger: 'early fraud warning', key: 'efw:issfr_1:linked' },
      logger
    );
    // A credit pack never unlocks the signup grant.
    expect(mocks.subtractCredits).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('refunded 100.00 USD');
    expect(message).toContain('166667 credits clawed back');
    expect(message).toContain('account locked, API keys deactivated');
    expect(message).toContain('1 card-linked account(s) locked');
    expect(message).not.toContain('fp_1');
    expect(mocks.markCompleted).toHaveBeenCalledWith('efw:issfr_1', 'u1');
    expect(mocks.alertStripeRiskEvent).not.toHaveBeenCalled();
  });

  it('skips a warning it already handled', async () => {
    mocks.isCompleted.mockResolvedValue(true);

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.chargesRetrieve).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('does not alert twice when a retry finds the alert already claimed', async () => {
    mocks.claimStep.mockResolvedValue(false);

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
    expect(mocks.markCompleted).toHaveBeenCalled();
  });

  it('does not refund a charge that is already refunded, but still locks', async () => {
    mocks.chargesRetrieve.mockResolvedValue(charge({ refunded: true, amount_refunded: 10000 }));

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.lockAccountForPaymentRisk).toHaveBeenCalled();
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('already refunded');
  });

  it('only alerts when the setting is off', async () => {
    mocks.settings = { paymentRiskAutoRefundEnabled: 'false' };

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.alertStripeRiskEvent).toHaveBeenCalledWith(warningEvent, logger);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.lockAccountForPaymentRisk).not.toHaveBeenCalled();
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });

  it('locks without refunding when less of the purchase is unspent than the threshold', async () => {
    mocks.settings = { paymentRiskAutoRefundMinUnspentPercent: '80' };
    mocks.findById.mockResolvedValue({ ...user, currentCredits: 16_667 });

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.lockAccountForPaymentRisk).toHaveBeenCalled();
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('not refunded: 10% of its credits unspent');
  });

  it('on a subscription charge, claws back the signup credits it unlocked and cancels subscriptions on that card', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue(null);
    mocks.findByStripeCustomerId.mockResolvedValue({ id: 'u1' });
    mocks.findById.mockResolvedValue({
      ...user,
      currentCredits: 40_000,
      signupGrant: { unlockedBy: 'subscription', unlockCredits: 25_000 },
    });
    mocks.findNonTerminalSubscriptionsByOwner.mockResolvedValue([
      { subscriptionId: 'sub_same', source: 'stripe' },
      { subscriptionId: 'sub_other', source: 'stripe' },
      { subscriptionId: 'admin_grant_1', source: 'admin_grant' },
    ]);
    mocks.subscriptionsRetrieve.mockImplementation(async (id: string) => ({
      status: 'active',
      default_payment_method: { card: { fingerprint: id === 'sub_same' ? 'fp_1' : 'fp_9' } },
    }));

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.refundsCreate).toHaveBeenCalled();
    expect(mocks.clawbackRefundCredits).not.toHaveBeenCalled();
    expect(mocks.claimStep).toHaveBeenCalledWith('efw:issfr_1', 'signupClawback', 'u1');
    expect(mocks.subtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', credits: 25_000, reason: 'abuse_clawback' }),
      expect.anything()
    );
    expect(mocks.subscriptionsCancel).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptionsCancel).toHaveBeenCalledWith('sub_same');
    expect(mocks.voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_same');
    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('25000 unlocked signup credits clawed back');
    expect(message).toContain('cancelled `sub_same`');
  });

  it('claws the signup credits back at most once across retries', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue(null);
    mocks.findByStripeCustomerId.mockResolvedValue({ id: 'u1' });
    mocks.findById.mockResolvedValue({ ...user, signupGrant: { unlockedBy: 'subscription', unlockCredits: 25_000 } });
    mocks.claimStep.mockImplementation(async (_key: string, step: string) => step !== 'signupClawback');

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.subtractCredits).not.toHaveBeenCalled();
  });

  it('falls back to the plain alert when no user here owns the charge', async () => {
    mocks.findByPaymentIntentId.mockResolvedValue(null);
    mocks.findByStripeCustomerId.mockResolvedValue(null);

    await respondToEarlyFraudWarning(warningEvent, logger);

    expect(mocks.alertStripeRiskEvent).toHaveBeenCalledWith(warningEvent, logger);
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.markCompleted).toHaveBeenCalledWith('efw:issfr_1', null);
  });

  it('contains the account and alerts before a refused refund fails the delivery for a retry', async () => {
    const refused = Object.assign(new Error('This charge has an open dispute'), { code: 'charge_disputed' });
    mocks.refundsCreate.mockRejectedValue(refused);

    await expect(respondToEarlyFraudWarning(warningEvent, logger)).rejects.toBe(refused);
    expect(mocks.lockAccountForPaymentRisk).toHaveBeenCalledWith(user);
    expect(mocks.propagateAccountRisk).toHaveBeenCalled();
    expect(mocks.clawbackRefundCredits).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('*refund failed* (charge_disputed)');
    expect(message).toContain('account locked');
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });

  it('lets a containment failure propagate before any refund, without marking it done', async () => {
    mocks.lockAccountForPaymentRisk.mockRejectedValue(new Error('db down'));

    await expect(respondToEarlyFraudWarning(warningEvent, logger)).rejects.toThrow('db down');
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });
});
