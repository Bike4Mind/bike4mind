import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  findById: vi.fn(),
  findByStripeCustomerId: vi.fn(),
  recordStart: vi.fn(),
  recordOutcome: vi.fn(),
  countAccountsForCard: vi.fn(),
  countRecentCards: vi.fn(),
  chargesRetrieve: vi.fn(),
  postMessageToSlack: vi.fn(),
  lockIfPaidWithBlockedCard: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: mocks.findById, findByStripeCustomerId: mocks.findByStripeCustomerId },
  paymentAttemptRepository: {
    recordStart: mocks.recordStart,
    recordOutcome: mocks.recordOutcome,
    countAccountsForCard: mocks.countAccountsForCard,
    countRecentCards: mocks.countRecentCards,
  },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { charges: { retrieve: mocks.chargesRetrieve } },
}));
vi.mock('@bike4mind/server-utils/auth/signupNetworkSignals', () => ({
  hashSignupNetwork: (ip: string | null) => ({ ipHash: ip ? `hash:${ip}` : null, prefixHash: null }),
}));
// Loaded through subscriptionLifecycle (admin links); its model needs a real mongoose.
vi.mock('@server/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('@server/billing/linkedAccounts', () => ({ lockIfPaidWithBlockedCard: mocks.lockIfPaidWithBlockedCard }));

import {
  alertStripeRiskEvent,
  evaluatePaymentRiskSignals,
  formatPaymentRiskAlert,
  paymentNetworkOf,
  readPaymentRiskThresholds,
  recordPaymentStart,
  screenPaymentOutcome,
  type PaymentRiskThresholds,
} from './paymentRisk';

const thresholds: PaymentRiskThresholds = {
  enabled: true,
  youngAccountMinutes: 60,
  maxAccountsPerCard: 1,
  maxCardsPerWindow: 1,
  cardWindowMinutes: 60,
  flagHostingNetwork: true,
};
const now = new Date('2026-10-30T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const quietCounts = { accountsForCard: 1, userCards: 1, networkCards: 1 };
const paidAttempt = { outcome: 'succeeded' as const, hostingNetwork: false, riskLevel: 'normal' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
  typeof screenPaymentOutcome
>[1];

const charge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge =>
  ({
    id: 'ch_1',
    amount: 10000,
    currency: 'usd',
    customer: 'cus_1',
    metadata: {},
    payment_method_details: { card: { fingerprint: 'fp_1' } },
    outcome: { risk_level: 'normal', risk_score: 12, type: 'authorized', reason: null },
    ...overrides,
  }) as unknown as Stripe.Charge;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
});

describe('readPaymentRiskThresholds', () => {
  it('falls back to the defaults and reads admin overrides', () => {
    expect(readPaymentRiskThresholds({})).toEqual(thresholds);
    expect(
      readPaymentRiskThresholds({ paymentRiskYoungAccountMinutes: '15', paymentRiskAlertsEnabled: 'false' })
    ).toMatchObject({ youngAccountMinutes: 15, enabled: false });
  });
});

describe('evaluatePaymentRiskSignals', () => {
  const evaluate = (overrides: Partial<Parameters<typeof evaluatePaymentRiskSignals>[0]>) =>
    evaluatePaymentRiskSignals({
      attempt: paidAttempt,
      accountCreatedAt: minutesAgo(24 * 60),
      now,
      counts: quietCounts,
      thresholds,
      ...overrides,
    });

  it('trips nothing for an established account paying with its one card', () => {
    expect(evaluate({})).toEqual([]);
  });

  it('flags a payment from an account younger than the threshold', () => {
    expect(evaluate({ accountCreatedAt: minutesAgo(1) })).toEqual([{ type: 'youngAccount', accountAgeMinutes: 1 }]);
    expect(evaluate({ accountCreatedAt: minutesAgo(60) })).toEqual([]);
  });

  it('flags one card on several accounts and several cards from one account or network', () => {
    expect(evaluate({ counts: { accountsForCard: 2, userCards: 2, networkCards: 3 } })).toEqual([
      { type: 'sharedCard', accounts: 2 },
      { type: 'manyCardsPerAccount', cards: 2 },
      { type: 'manyCardsPerNetwork', cards: 3 },
    ]);
  });

  it('never treats an unknown count as a breach', () => {
    expect(evaluate({ counts: { accountsForCard: null, userCards: null, networkCards: null } })).toEqual([]);
  });

  it('flags a hosting network and an elevated Radar risk on a paid attempt', () => {
    expect(evaluate({ attempt: { outcome: 'succeeded', hostingNetwork: true, riskLevel: 'elevated' } })).toEqual([
      { type: 'hostingNetwork' },
      { type: 'radarRisk', riskLevel: 'elevated' },
    ]);
  });

  it('checks only the card counts on a failed attempt', () => {
    expect(
      evaluate({
        attempt: { outcome: 'failed', hostingNetwork: true, riskLevel: 'highest' },
        accountCreatedAt: minutesAgo(1),
        counts: { accountsForCard: 1, userCards: 2, networkCards: 1 },
      })
    ).toEqual([{ type: 'manyCardsPerAccount', cards: 2 }]);
  });

  it('turns a check off at 0', () => {
    expect(
      evaluate({
        accountCreatedAt: minutesAgo(1),
        counts: { accountsForCard: 5, userCards: 5, networkCards: 5 },
        thresholds: { ...thresholds, youngAccountMinutes: 0, maxAccountsPerCard: 0, maxCardsPerWindow: 0 },
      })
    ).toEqual([]);
  });
});

describe('paymentNetworkOf', () => {
  it('hashes the IP and calls the network hosted when either signal says so', () => {
    expect(paymentNetworkOf({ ip: '203.0.113.7', isDatacenter: false, wafAnonIp: true })).toEqual({
      ipHash: 'hash:203.0.113.7',
      hostingNetwork: true,
    });
    expect(paymentNetworkOf({ ip: null, isDatacenter: false, wafAnonIp: null }).hostingNetwork).toBe(false);
    expect(paymentNetworkOf({ ip: null, isDatacenter: null, wafAnonIp: null }).hostingNetwork).toBeNull();
  });
});

describe('recordPaymentStart', () => {
  it('logs instead of throwing when the write fails', async () => {
    mocks.recordStart.mockRejectedValue(new Error('db down'));
    const network = { ip: '203.0.113.7', isDatacenter: true } as Parameters<typeof recordPaymentStart>[0]['network'];

    await expect(
      recordPaymentStart({ paymentIntentId: 'pi_1', userId: 'u1', amount: 100, currency: 'usd', network }, logger)
    ).resolves.toBeUndefined();
    expect(mocks.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ ipHash: 'hash:203.0.113.7', hostingNetwork: true, kind: 'credits' })
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('screenPaymentOutcome', () => {
  const input = {
    paymentIntentId: 'pi_1',
    userId: 'u1',
    kind: 'credits' as const,
    amount: 10000,
    currency: 'usd',
    outcome: 'succeeded' as const,
    chargeRef: 'ch_1',
  };
  const recorded = {
    ...input,
    cardFingerprints: ['fp_1'],
    riskLevel: 'normal',
    ipHash: 'hash:ip',
    hostingNetwork: false,
    createdAt: now,
  };

  beforeEach(() => {
    mocks.chargesRetrieve.mockResolvedValue(charge());
    mocks.findById.mockResolvedValue({ id: 'u1', createdAt: minutesAgo(1) });
    mocks.recordOutcome.mockResolvedValue({ attempt: recorded, changed: true });
    mocks.countAccountsForCard.mockResolvedValue(2);
    mocks.countRecentCards.mockResolvedValue({ userCards: 1, networkCards: 1 });
  });

  it('records the card and Radar outcome, then alerts with every signal that fired', async () => {
    await screenPaymentOutcome(input, logger, now);

    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_1', cardFingerprint: 'fp_1', riskLevel: 'normal' })
    );
    expect(mocks.countAccountsForCard).toHaveBeenCalledWith('fp_1');
    expect(mocks.countRecentCards).toHaveBeenCalledWith({ userId: 'u1', ipHash: 'hash:ip', since: minutesAgo(60) });
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('account is 1 min old');
    expect(message).toContain('card used on 2 accounts');
    expect(message).toContain('100.00 USD');
    expect(message).not.toContain('fp_1');
  });

  it('records but does not alert when nothing fires', async () => {
    mocks.findById.mockResolvedValue({ id: 'u1', createdAt: minutesAgo(24 * 60) });
    mocks.countAccountsForCard.mockResolvedValue(1);

    await screenPaymentOutcome(input, logger, now);

    expect(mocks.recordOutcome).toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('does not alert again on a Stripe redelivery', async () => {
    mocks.recordOutcome.mockResolvedValue({ attempt: recorded, changed: false });

    await screenPaymentOutcome(input, logger, now);

    expect(mocks.countAccountsForCard).not.toHaveBeenCalled();
    expect(mocks.countRecentCards).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('uses the failing payment method when the attempt has no charge', async () => {
    await screenPaymentOutcome(
      { ...input, outcome: 'failed', chargeRef: null, fallbackCardFingerprint: 'fp_2' },
      logger,
      now
    );

    expect(mocks.chargesRetrieve).not.toHaveBeenCalled();
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ cardFingerprint: 'fp_2' }));
  });

  it('still records, for the checkout gate, but does not alert when the admin switch is off', async () => {
    mocks.settings = { paymentRiskAlertsEnabled: 'false' };

    await screenPaymentOutcome(input, logger, now);

    expect(mocks.recordOutcome).toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('marks a Radar-blocked attempt so the checkout gate can count it', async () => {
    mocks.chargesRetrieve.mockResolvedValue(
      charge({ outcome: { type: 'blocked', risk_level: 'highest' } as unknown as Stripe.Charge['outcome'] })
    );
    mocks.recordOutcome.mockResolvedValue({ attempt: { ...recorded, outcome: 'failed' }, changed: true });

    await screenPaymentOutcome({ ...input, outcome: 'failed' }, logger, now);

    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ radarBlocked: true }));
    expect(mocks.lockIfPaidWithBlockedCard).not.toHaveBeenCalled();
  });

  it('checks a paid card against blocked accounts', async () => {
    await screenPaymentOutcome(input, logger, now);

    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ radarBlocked: false }));
    expect(mocks.lockIfPaidWithBlockedCard).toHaveBeenCalledWith(
      { userId: 'u1', paymentIntentId: 'pi_1', cardFingerprints: ['fp_1'] },
      logger
    );
  });

  it('never throws into the webhook', async () => {
    mocks.chargesRetrieve.mockRejectedValue(new Error('stripe down'));

    await expect(screenPaymentOutcome(input, logger, now)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('formatPaymentRiskAlert', () => {
  it('names the user, payment and signals without card details', () => {
    const message = formatPaymentRiskAlert(
      {
        paymentIntentId: 'pi_1',
        userId: 'u1',
        kind: 'subscription',
        amount: 3000,
        currency: 'usd',
        cardFingerprints: ['fp_1'],
        outcome: 'succeeded',
        riskLevel: null,
        ipHash: null,
        hostingNetwork: true,
        createdAt: now,
      },
      [{ type: 'hostingNetwork' }],
      thresholds
    );

    expect(message).toContain('subscription payment succeeded');
    expect(message).toContain('`u1`');
    expect(message).toContain('`pi_1`');
    expect(message).toContain('*Radar risk:* not reported');
    expect(message).toContain('hosting/VPN network');
    expect(message).not.toContain('fp_1');
  });
});

describe('alertStripeRiskEvent', () => {
  const event = (type: string, object: Record<string, unknown>) =>
    ({ type, data: { object } }) as unknown as Stripe.Event;

  beforeEach(() => {
    mocks.findByStripeCustomerId.mockResolvedValue({ id: 'u1' });
  });

  it('forwards an early fraud warning with the user, ids, amount and Radar risk', async () => {
    mocks.chargesRetrieve.mockResolvedValue(
      charge({ outcome: { risk_level: 'highest', risk_score: 91, type: 'authorized' } as Stripe.Charge.Outcome })
    );

    await alertStripeRiskEvent(
      event('radar.early_fraud_warning.created', {
        charge: 'ch_1',
        payment_intent: 'pi_1',
        fraud_type: 'made_with_stolen_card',
        actionable: true,
      }),
      logger
    );

    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('Stripe early fraud warning');
    expect(message).toContain('`u1`');
    expect(message).toContain('`pi_1` / `ch_1`');
    expect(message).toContain('100.00 USD');
    expect(message).toContain('*Radar risk:* highest (score 91)');
    expect(message).toContain('made_with_stolen_card');
  });

  it('forwards an opened review', async () => {
    mocks.chargesRetrieve.mockResolvedValue(charge());

    await alertStripeRiskEvent(
      event('review.opened', { charge: 'ch_1', payment_intent: 'pi_1', reason: 'rule' }),
      logger
    );

    expect(mocks.postMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('Stripe Radar review opened'));
  });

  it('alerts on a Radar-blocked payment, not on a plain decline', async () => {
    const failed = event('payment_intent.payment_failed', { id: 'pi_1', last_payment_error: { charge: 'ch_1' } });

    const declined = charge({ outcome: { risk_level: 'normal', type: 'issuer_declined' } as Stripe.Charge.Outcome });
    mocks.chargesRetrieve.mockResolvedValue(declined);
    await expect(alertStripeRiskEvent(failed, logger)).resolves.toBe(declined);
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();

    mocks.chargesRetrieve.mockResolvedValue(
      charge({
        outcome: { risk_level: 'highest', type: 'blocked', reason: 'highest_risk_level' } as Stripe.Charge.Outcome,
      })
    );
    await alertStripeRiskEvent(failed, logger);
    expect(mocks.postMessageToSlack).toHaveBeenCalledWith(expect.stringContaining('blocked / highest_risk_level'));
  });

  it('ignores events that carry no risk', async () => {
    await alertStripeRiskEvent(event('charge.refunded', { id: 'ch_1' }), logger);

    expect(mocks.chargesRetrieve).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });
});
