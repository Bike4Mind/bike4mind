// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const { mockFindById, mockRepo, mockAddCredits, mockSubtractCredits, mockClawbackLots, mockGetSettingsMap, mockAlert } =
  vi.hoisted(() => ({
    mockFindById: vi.fn(),
    mockRepo: {
      create: vi.fn(),
      findByInvoiceId: vi.fn(),
      findByPaymentIntentId: vi.fn(),
      countClaimedSteps: vi.fn(),
      findDue: vi.fn(),
      claimForRelease: vi.fn(),
      cancelPending: vi.fn(),
      recordTakeBack: vi.fn(),
    },
    mockAddCredits: vi.fn(),
    mockSubtractCredits: vi.fn(),
    mockClawbackLots: vi.fn(),
    mockGetSettingsMap: vi.fn(),
    mockAlert: vi.fn(),
  }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  referralSubscriptionRewardRepository: mockRepo,
  User: { findById: mockFindById },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: {
    addCreditsWithLedgerRow: mockAddCredits,
    subtractCredits: mockSubtractCredits,
    clawbackCreditLotsByStripeRef: mockClawbackLots,
  },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: mockGetSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, string>, fallback = 0) => Number(settings[key] ?? fallback),
}));
vi.mock('@bike4mind/observability', () => {
  class Logger {
    static error = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  }
  return { Logger };
});
vi.mock('@client/lib/userSubscriptions/constants', () => ({ PROFESSIONAL_PRICE_ID: 'price_pro' }));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('./firstAnswerReward', async importActual => ({
  ...(await importActual<typeof import('./firstAnswerReward')>()),
  alertIfRewardsSpike: mockAlert,
}));

import {
  isFullPriceProfessionalInvoice,
  recordSubscriptionPaymentReward,
  releaseDueSubscriptionRewards,
  reverseSubscriptionRewardForRefund,
} from './subscriptionReward';

const NOW = new Date('2026-11-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const invoice = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'in_1',
    billing_reason: 'subscription_create',
    amount_paid: 3000,
    discounts: [],
    total_discount_amounts: [],
    lines: { data: [{ pricing: { price_details: { price: 'price_pro' } }, discount_amounts: [] }] },
    payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] },
    ...overrides,
  }) as unknown as Stripe.Invoice;
const subscription = (priceId = 'price_pro', items = 1) =>
  ({
    items: { data: Array.from({ length: items }, () => ({ price: { id: priceId } })) },
  }) as unknown as Stripe.Subscription;

const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const givenUsers = (payer: unknown, inviter: unknown = {}) =>
  mockFindById.mockImplementation((id: string) => lean(id === 'friend1' ? payer : inviter));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettingsMap.mockResolvedValue({
    ReferralFirstPaymentCredits: '6000',
    ReferralSecondPaymentCredits: '7000',
    ReferralHoldDays: '14',
    ReferralAlertRewardsPerDay: '50',
  });
  givenUsers({ referredByUserId: 'inviter1' });
  mockRepo.findByInvoiceId.mockResolvedValue(null);
  mockRepo.countClaimedSteps.mockResolvedValue(0);
  mockRepo.create.mockResolvedValue({ id: 'r1' });
  mockAddCredits.mockResolvedValue({ creditTransactionId: 'tx1' });
});

describe('isFullPriceProfessionalInvoice', () => {
  it('accepts a sign-up and a renewal invoice for the Professional price with no discount', () => {
    expect(isFullPriceProfessionalInvoice(invoice(), subscription())).toBe(true);
    expect(isFullPriceProfessionalInvoice(invoice({ billing_reason: 'subscription_cycle' }), subscription())).toBe(
      true
    );
  });

  it.each([
    ['a plan change', { billing_reason: 'subscription_update' }],
    ['a manual invoice', { billing_reason: 'manual' }],
    ['nothing paid', { amount_paid: 0 }],
    ['a coupon on the invoice', { discounts: ['di_1'] }],
    ['a discounted total', { total_discount_amounts: [{ amount: 500 }] }],
    [
      'a discounted line',
      { lines: { data: [{ pricing: { price_details: { price: 'price_pro' } }, discount_amounts: [{ amount: 1 }] }] } },
    ],
    [
      'another plan line',
      { lines: { data: [{ pricing: { price_details: { price: 'price_team' } }, discount_amounts: [] }] } },
    ],
    ['an extra line', { lines: { data: [{ pricing: { price_details: { price: 'price_pro' } } }, { pricing: null }] } }],
  ])('rejects %s', (_label, overrides) => {
    expect(isFullPriceProfessionalInvoice(invoice(overrides), subscription())).toBe(false);
  });

  it('rejects another plan or extra subscription items', () => {
    expect(isFullPriceProfessionalInvoice(invoice(), subscription('price_team'))).toBe(false);
    expect(isFullPriceProfessionalInvoice(invoice(), subscription('price_pro', 2))).toBe(false);
  });
});

describe('recordSubscriptionPaymentReward', () => {
  const record = () =>
    recordSubscriptionPaymentReward({ invoice: invoice(), subscription: subscription(), payerId: 'friend1', now: NOW });

  it('holds the first-payment reward with the locked amount and the release date', async () => {
    await record();
    expect(mockRepo.create).toHaveBeenCalledWith(
      {
        invoiceId: 'in_1',
        paymentIntentId: 'pi_1',
        payerId: 'friend1',
        inviterId: 'inviter1',
        step: 'first_payment',
        credits: 6000,
        releaseAt: new Date(NOW.getTime() + 14 * DAY_MS),
      },
      NOW
    );
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('uses the second-payment amount once one reward is already counted', async () => {
    mockRepo.countClaimedSteps.mockResolvedValue(1);
    await record();
    expect(mockRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'second_payment', credits: 7000 }),
      NOW
    );
  });

  it('pays nothing past the second payment', async () => {
    mockRepo.countClaimedSteps.mockResolvedValue(2);
    await record();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('is a no-op while both payment amounts are 0', async () => {
    mockGetSettingsMap.mockResolvedValue({ ReferralFirstPaymentCredits: '0', ReferralSecondPaymentCredits: '0' });
    await record();
    expect(mockRepo.create).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('still records a step whose own amount is 0, so the next payment takes the right step', async () => {
    mockGetSettingsMap.mockResolvedValue({ ReferralFirstPaymentCredits: '0', ReferralSecondPaymentCredits: '7000' });
    await record();
    expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ step: 'first_payment', credits: 0 }), NOW);

    mockRepo.countClaimedSteps.mockResolvedValue(1);
    await record();
    expect(mockRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: 'second_payment', credits: 7000 }),
      NOW
    );
  });

  it('retries at the next step when a concurrent invoice of the payer took the step', async () => {
    mockRepo.countClaimedSteps.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mockRepo.create.mockResolvedValueOnce(null);
    await record();
    expect(mockRepo.create).toHaveBeenCalledTimes(2);
    expect(mockRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: 'second_payment', credits: 7000 }),
      NOW
    );
  });

  it('skips an invoice that already has a reward', async () => {
    mockRepo.findByInvoiceId.mockResolvedValue({ id: 'r0' });
    await record();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('skips an invoice that is not full price', async () => {
    await recordSubscriptionPaymentReward({
      invoice: invoice({ discounts: ['di_1'] }),
      subscription: subscription(),
      payerId: 'friend1',
    });
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['has no inviter', { referredByUserId: null }],
    ['is synthetic', { referredByUserId: 'inviter1', isSynthetic: true }],
    ['is deleted', { referredByUserId: 'inviter1', deletedAt: new Date() }],
    ['invited themselves', { referredByUserId: 'friend1' }],
    ['is banned', { referredByUserId: 'inviter1', isBanned: true }],
    ['has a chargeback pending', { referredByUserId: 'inviter1', disputePending: true }],
    ['is pending suspension', { referredByUserId: 'inviter1', moderation: { status: 'suspend_pending' } }],
    ['no longer exists', null],
  ])('pays nothing when the payer %s', async (_label, payer) => {
    givenUsers(payer);
    await record();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['is deleted', { deletedAt: new Date() }],
    ['is synthetic', { isSynthetic: true }],
    ['is banned', { isBanned: true }],
    ['has a chargeback pending', { disputePending: true }],
    ['is pending suspension', { moderation: { status: 'suspend_pending' } }],
    ['no longer exists', null],
  ])('pays nothing when the inviter %s', async (_label, inviter) => {
    givenUsers({ referredByUserId: 'inviter1' }, inviter);
    await record();
    expect(mockRepo.create).not.toHaveBeenCalled();
  });

  it('never throws, even when the write fails', async () => {
    mockRepo.create.mockRejectedValue(new Error('db down'));
    await expect(record()).resolves.toBeUndefined();
  });
});

describe('releaseDueSubscriptionRewards', () => {
  const due = {
    id: 'r1',
    inviterId: 'inviter1',
    payerId: 'friend1',
    invoiceId: 'in_1',
    step: 'first_payment',
    credits: 6000,
  };

  beforeEach(() => {
    mockRepo.findDue.mockResolvedValue([due]);
    mockRepo.claimForRelease.mockResolvedValue(due);
    mockRepo.cancelPending.mockResolvedValue(true);
  });

  it('credits a due reward once with a stable key and the locked amount, then checks the alert', async () => {
    const result = await releaseDueSubscriptionRewards({ now: NOW });

    expect(result).toEqual({ candidates: 1, released: 1, cancelled: 0, failed: 0 });
    expect(mockAddCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'inviter1',
      credits: 6000,
      type: 'generic_add',
      reason: 'referral_reward',
      transactionId: 'referral-subscription:inviter1:in_1',
    });
    expect(mockAlert).toHaveBeenCalledWith('tx1', 50);
  });

  it('does nothing when no reward is due', async () => {
    mockRepo.findDue.mockResolvedValue([]);
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result.candidates).toBe(0);
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('skips a reward another run already claimed', async () => {
    mockRepo.claimForRelease.mockResolvedValue(null);
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result.released).toBe(0);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('cancels instead of paying when the inviter is now blocked', async () => {
    givenUsers({}, { isBanned: true });
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result).toMatchObject({ released: 0, cancelled: 1 });
    expect(mockRepo.cancelPending).toHaveBeenCalledWith('r1', 'inviter_blocked', NOW);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it.each([
    ['is banned', { isBanned: true }],
    ['has a chargeback pending', { disputePending: true }],
    ['no longer exists', null],
  ])('cancels instead of paying when the payer %s', async (_label, payer) => {
    givenUsers(payer);
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result).toMatchObject({ released: 0, cancelled: 1 });
    expect(mockRepo.cancelPending).toHaveBeenCalledWith('r1', 'payer_blocked', NOW);
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('counts a failed grant and carries on with the next reward', async () => {
    mockRepo.findDue.mockResolvedValue([due, { ...due, id: 'r2', invoiceId: 'in_2' }]);
    mockRepo.claimForRelease.mockImplementation((id: string) => Promise.resolve({ ...due, id }));
    mockAddCredits.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ creditTransactionId: 'tx2' });
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result).toMatchObject({ released: 1, failed: 1 });
  });

  it('does not alert on a replay that wrote no ledger row', async () => {
    mockAddCredits.mockResolvedValue({ creditTransactionId: undefined });
    const result = await releaseDueSubscriptionRewards({ now: NOW });
    expect(result.released).toBe(1);
    expect(mockAlert).not.toHaveBeenCalled();
  });
});

describe('reverseSubscriptionRewardForRefund', () => {
  const released = {
    id: 'r1',
    inviterId: 'inviter1',
    payerId: 'friend1',
    invoiceId: 'in_1',
    step: 'first_payment',
    status: 'released',
    credits: 6000,
    refundTargetCredits: 0,
    takenBackCredits: 0,
  };
  const refund = (amountRefunded: number) =>
    reverseSubscriptionRewardForRefund({ paymentIntentId: 'pi_1', amountRefunded, amountCaptured: 3000, now: NOW });

  beforeEach(() => {
    mockRepo.findByPaymentIntentId.mockResolvedValue(released);
    mockRepo.recordTakeBack.mockResolvedValue(true);
    givenUsers({}, { currentCredits: 100_000 });
  });

  it('cancels a reward that is still held, on any refund', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue({ ...released, status: 'pending' });
    await refund(100);
    expect(mockRepo.cancelPending).toHaveBeenCalledWith('r1', 'refunded', NOW);
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('does nothing when no reward matches the payment', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue(null);
    await refund(3000);
    expect(mockRepo.recordTakeBack).not.toHaveBeenCalled();
  });

  it('takes back the whole reward on a full refund and frees the step', async () => {
    await refund(3000);
    expect(mockRepo.recordTakeBack).toHaveBeenCalledWith(
      'r1',
      0,
      { refundTargetCredits: 6000, takenBackCredits: 6000, fullyRefunded: true },
      NOW
    );
    expect(mockSubtractCredits.mock.calls[0][0]).toMatchObject({
      ownerId: 'inviter1',
      credits: 6000,
      reason: 'referral_reward_takeback',
    });
    expect(mockClawbackLots).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^referral-subscription:inviter1:/),
      'proportional',
      6000,
      expect.anything()
    );
  });

  it('takes back only the refunded share on a partial refund', async () => {
    await refund(1500);
    expect(mockRepo.recordTakeBack).toHaveBeenCalledWith(
      'r1',
      0,
      { refundTargetCredits: 3000, takenBackCredits: 3000, fullyRefunded: false },
      NOW
    );
  });

  it('takes back only the unspent part and never goes below zero', async () => {
    givenUsers({}, { currentCredits: 2500 });
    await refund(3000);
    expect(mockSubtractCredits.mock.calls[0][0].credits).toBe(2500);
    expect(mockRepo.recordTakeBack.mock.calls[0][2]).toMatchObject({
      refundTargetCredits: 6000,
      takenBackCredits: 2500,
    });

    givenUsers({}, { currentCredits: 0 });
    mockSubtractCredits.mockClear();
    await refund(3000);
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('applies only the newly refunded share when an earlier refund was already handled', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue({
      ...released,
      refundTargetCredits: 3000,
      takenBackCredits: 3000,
    });
    await refund(3000);
    expect(mockSubtractCredits.mock.calls[0][0].credits).toBe(3000);
  });

  it('ignores a redelivered event that adds nothing new', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue({
      ...released,
      refundTargetCredits: 6000,
      takenBackCredits: 6000,
    });
    await refund(3000);
    expect(mockRepo.recordTakeBack).not.toHaveBeenCalled();
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('deducts nothing and gives up after repeated concurrent updates', async () => {
    mockRepo.recordTakeBack.mockResolvedValue(false);
    await refund(3000);
    expect(mockRepo.findByPaymentIntentId).toHaveBeenCalledTimes(3);
    expect(mockSubtractCredits).not.toHaveBeenCalled();
  });

  it('re-reads and applies the larger refund when a concurrent event moved the target first', async () => {
    mockRepo.findByPaymentIntentId
      .mockResolvedValueOnce(released)
      .mockResolvedValueOnce({ ...released, refundTargetCredits: 3000, takenBackCredits: 3000 });
    mockRepo.recordTakeBack.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await refund(3000);

    expect(mockRepo.recordTakeBack).toHaveBeenLastCalledWith(
      'r1',
      3000,
      { refundTargetCredits: 6000, takenBackCredits: 6000, fullyRefunded: true },
      NOW
    );
    expect(mockSubtractCredits).toHaveBeenCalledTimes(1);
    expect(mockSubtractCredits.mock.calls[0][0].credits).toBe(3000);
  });

  it('takes back from the released reward when the release job claimed it before the cancel', async () => {
    mockRepo.findByPaymentIntentId
      .mockResolvedValueOnce({ ...released, status: 'pending' })
      .mockResolvedValueOnce(released);
    mockRepo.cancelPending.mockResolvedValue(false);

    await refund(3000);

    expect(mockRepo.recordTakeBack).toHaveBeenCalledTimes(1);
    expect(mockSubtractCredits.mock.calls[0][0].credits).toBe(6000);
  });

  it('passes a chargeback through as a full refund with its own close reason', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue({ ...released, status: 'pending' });
    await reverseSubscriptionRewardForRefund({
      paymentIntentId: 'pi_1',
      amountRefunded: 3000,
      amountCaptured: 3000,
      reason: 'disputed',
      now: NOW,
    });
    expect(mockRepo.cancelPending).toHaveBeenCalledWith('r1', 'disputed', NOW);
  });

  it('ignores a refund of nothing', async () => {
    await refund(0);
    expect(mockRepo.findByPaymentIntentId).not.toHaveBeenCalled();
  });

  it('ignores a reward that was already closed', async () => {
    mockRepo.findByPaymentIntentId.mockResolvedValue({ ...released, status: 'cancelled' });
    await refund(3000);
    expect(mockRepo.recordTakeBack).not.toHaveBeenCalled();
  });
});
