import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { authenticatedSetupAttempt, parseCardDefensePolicy } from './cardVerificationPolicy';

const policy = {
  accountId: 'acct_synthetic',
  validUntil: '2099-01-01T00:00:00.000Z',
  setupRadarEnabled: true,
  highRiskBlockEnabled: true,
  allowRulesReviewed: true,
  alertsReady: true,
  attemptsWindowMs: 1000,
  accountAttempts: 2,
  ipAttempts: 3,
  asnAttempts: 4,
  accountDailyFailures: 2,
  ipDailyFailures: 3,
  failureSpikeCount: 4,
  failureSpikeWindowMs: 1000,
};
describe('card defense policy', () => {
  it('refuses unset, malformed, expired and incomplete configuration', () => {
    for (const input of [
      undefined,
      'invalid',
      '{}',
      JSON.stringify({ ...policy, validUntil: '2000-01-01T00:00:00.000Z' }),
      JSON.stringify({ ...policy, setupRadarEnabled: false }),
      JSON.stringify({ ...policy, ipAttempts: 0 }),
    ]) {
      expect(parseCardDefensePolicy(input)).toBeNull();
    }
    expect(parseCardDefensePolicy(JSON.stringify(policy))).toEqual(policy);
  });
});

describe('supported SetupAttempt evidence', () => {
  const intent = {
    id: 'seti_synthetic',
    status: 'succeeded',
    customer: 'cus_synthetic',
    payment_method: 'pm_synthetic',
    latest_attempt: 'setatt_synthetic',
    livemode: false,
    last_setup_error: null,
  } as Stripe.SetupIntent;
  const attempt = {
    id: 'setatt_synthetic',
    setup_intent: 'seti_synthetic',
    status: 'succeeded',
    customer: 'cus_synthetic',
    payment_method: 'pm_synthetic',
    livemode: false,
    setup_error: null,
    payment_method_details: { type: 'card', card: { three_d_secure: { result: 'authenticated' } } },
  } as Stripe.SetupAttempt;
  it('accepts authenticated server-owned matching evidence only', () => {
    expect(authenticatedSetupAttempt(intent, attempt)).toBe(true);
  });
  it.each(['customer', 'payment_method', 'setup_intent', 'id', 'status'])('refuses mismatched %s', field => {
    expect(authenticatedSetupAttempt(intent, { ...attempt, [field]: 'other' })).toBe(false);
  });
  it('refuses missing authentication, failed setup and wrong mode', () => {
    expect(
      authenticatedSetupAttempt(intent, {
        ...attempt,
        payment_method_details: { type: 'card', card: { three_d_secure: null } },
      })
    ).toBe(false);
    expect(authenticatedSetupAttempt({ ...intent, status: 'processing' }, attempt)).toBe(false);
    expect(authenticatedSetupAttempt(intent, { ...attempt, livemode: true })).toBe(false);
  });
});
