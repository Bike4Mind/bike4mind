import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

const mocks = vi.hoisted(() => ({
  setting: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  limit: vi.fn(),
  account: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  lease: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  user: vi.fn(),
  grantLookup: vi.fn(),
}));
vi.mock('@bike4mind/database', async () => ({
  mongoose: (await import('mongoose')).default,
  adminSettingsRepository: { findBySettingName: mocks.setting },
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: mocks.limit,
    tryAcquireLease: mocks.lease,
    releaseLease: mocks.release,
  },
  CreditGrantIdentityClaim: { createIndexes: vi.fn() },
  creditTransactionRepository: { findOne: mocks.grantLookup },
  userRepository: { findById: mocks.user },
}));
vi.mock('@bike4mind/services', () => ({ userService: {} }));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: {} }));
vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: mocks.challenge,
  turnstileAllowedHostnames: () => ['example.test'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({ verifyTurnstile: mocks.verify }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    STAGE: 'test',
    CARD_VERIFICATION_IDENTITY_KEY: 'synthetic-key-'.repeat(4),
    CARD_VERIFICATION_WEBHOOK_SECRET: 'whsec_synthetic',
  },
  isProduction: () => false,
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: { accounts: { retrieve: mocks.account }, setupIntents: { retrieve: mocks.retrieve, cancel: mocks.cancel } },
}));
import {
  CardVerificationFailure,
  cardNetworkDigest,
  cardVerificationRuntime,
  reconcileCardVerifications,
  resetCardVerificationRuntimeCache,
  resumableVerificationSecret,
  verificationFailure,
  verificationOffer,
} from './cardVerificationRuntime';
import { finishCardVerification } from './cardVerificationRuntime';
vi.mock('./cardVerificationLifecycle', async importOriginal => ({
  ...(await importOriginal<typeof import('./cardVerificationLifecycle')>()),
  removeVerificationCard: mocks.remove,
}));
import { CardVerification } from './cardVerificationModel';
import { CardVerificationRefused } from './cardVerificationLifecycle';
import { Logger } from '@bike4mind/observability';

const defense = {
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
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetCardVerificationRuntimeCache();
  vi.stubEnv('CARD_VERIFICATION_RECOVERY_ENABLED', 'true');
  vi.stubEnv('CARD_VERIFICATION_DEFENSE_POLICY', JSON.stringify(defense));
  mocks.setting.mockImplementation(async (key: string) => ({
    settingValue: key === 'cardUnlockEnabled' ? 'true' : '17',
  }));
  mocks.challenge.mockResolvedValue({ active: true, secret: 'synthetic-secret', siteKey: 'synthetic-site' });
  mocks.account.mockResolvedValue({ id: 'acct_synthetic' });
  mocks.limit.mockResolvedValue({ success: true });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.lease.mockResolvedValue(true);
  vi.spyOn(CardVerificationFailure, 'countDocuments').mockResolvedValue(0);
  vi.spyOn(CardVerification.collection, 'listIndexes').mockReturnValue({
    toArray: async () => [{ unique: true, key: { verificationId: 1 } }],
  } as never);
  vi.spyOn(CardVerificationFailure.collection, 'listIndexes').mockReturnValue({
    toArray: async () => [{ unique: true, key: { attemptId: 1 } }],
  } as never);
});
const context = { userId: 'synthetic-user', ip: '192.0.2.1', asn: '64512', turnstileToken: 'synthetic-token' };

describe('mandatory verification defenses', () => {
  it.each([false, true])('expires abandoned setups quietly with the offer enabled=%s', async enabled => {
    const row = {
      verificationId: 'synthetic-verification',
      userId: 'synthetic-user',
      state: 'pending',
      environment: 'test',
      livemode: false,
      customerId: 'cus_synthetic',
      setupIntentId: 'seti_synthetic',
      createdAt: new Date(0),
    };
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [row] }) }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.setting.mockResolvedValue({ settingValue: String(enabled) });
    mocks.retrieve.mockResolvedValue({
      id: row.setupIntentId,
      customer: row.customerId,
      livemode: false,
      status: 'requires_payment_method',
      metadata: { verificationId: row.verificationId, purpose: 'card_verification', environment: 'test' },
    });
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(mocks.cancel).toHaveBeenCalledWith(row.setupIntentId);
    expect(CardVerification.updateOne).toHaveBeenCalledWith(
      { verificationId: row.verificationId, state: 'pending' },
      { $set: { state: 'refused' } }
    );
  });
  it('skips a recent pending saved-card verification quietly when the offer is disabled', async () => {
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              verificationId: 'synthetic',
              userId: 'synthetic-user',
              state: 'pending',
              saveCard: true,
              setupIntentId: 'seti_synthetic',
              createdAt: new Date(),
            },
          ],
        }),
      }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.setting.mockImplementation(async (key: string) => ({
      settingValue: key === 'cardUnlockEnabled' ? 'false' : '17',
    }));
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('retires an ineligible verified account without attempting another grant', async () => {
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              verificationId: 'synthetic',
              userId: 'synthetic-user',
              state: 'verified',
              saveCard: true,
              setupIntentId: 'seti_synthetic',
              createdAt: new Date(),
            },
          ],
        }),
      }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.user.mockResolvedValue(null);
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(CardVerification.updateOne).toHaveBeenCalledWith(
      { verificationId: 'synthetic', state: 'verified' },
      { $set: { state: 'refused' } }
    );
    expect(mocks.remove).toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it('builds the runtime once per recovery run', async () => {
    const row = { userId: 'synthetic-user', state: 'verified', saveCard: true, setupIntentId: 'seti_synthetic' };
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { ...row, verificationId: 'synthetic-a' },
            { ...row, verificationId: 'synthetic-b' },
          ],
        }),
      }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.user.mockResolvedValue(null);
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.account).toHaveBeenCalledTimes(1);
  });
  it('stops revisiting unnotified grants for accounts without email or past the retry window', async () => {
    const find = vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { verificationId: 'synthetic', userId: 'synthetic-user', state: 'granted', saveCard: true },
          ],
        }),
      }),
    } as never);
    vi.spyOn(CardVerification, 'findOne').mockReturnValue({
      lean: async () => ({ state: 'granted', saveCard: true, credits: 17 }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.user.mockResolvedValue({});
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(CardVerification.updateOne).toHaveBeenCalledWith(
      { verificationId: 'synthetic', userId: 'synthetic-user' },
      { $set: { notifiedAt: expect.any(Date) } }
    );
    expect(JSON.stringify(find.mock.calls[0][0])).toContain('"notifiedAt":null,"createdAt":{"$gte"');
  });
  it('reports a removal refused for an attached card instead of swallowing it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { verificationId: 'synthetic', userId: 'synthetic-user', state: 'refused', paymentMethodId: 'pm_x' },
          ],
        }),
      }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.remove.mockRejectedValueOnce(new CardVerificationRefused('ineligible'));
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'card-verification-recovery-refused',
      expect.objectContaining({ verificationId: 'synthetic' })
    );
  });
  it.each([
    ['requires_payment_method', 'synthetic-secret'],
    ['requires_action', 'synthetic-secret'],
    ['processing', null],
    ['canceled', null],
  ])('returns the owner setup secret for a %s setup only while resumable', async (status, expected) => {
    vi.spyOn(CardVerification, 'findOne').mockReturnValue({
      lean: async () => ({
        verificationId: 'synthetic',
        state: 'pending',
        environment: 'test',
        livemode: false,
        customerId: 'cus_synthetic',
        setupIntentId: 'seti_synthetic',
        createdAt: new Date(),
      }),
    } as never);
    mocks.retrieve.mockResolvedValue({
      id: 'seti_synthetic',
      customer: 'cus_synthetic',
      livemode: false,
      status,
      client_secret: 'synthetic-secret',
      metadata: { verificationId: 'synthetic', purpose: 'card_verification', environment: 'test' },
    });
    expect(await resumableVerificationSecret('synthetic', 'synthetic-user')).toBe(expected);
    expect(CardVerification.findOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'synthetic-user' }));
  });
  it.each(['succeeded', 'processing'])('does not cancel an old %s setup', async status => {
    const row = {
      verificationId: 'synthetic',
      userId: 'synthetic-user',
      state: 'pending',
      environment: 'test',
      livemode: false,
      customerId: 'cus_synthetic',
      setupIntentId: 'seti_synthetic',
      createdAt: new Date(0),
    };
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [row] }) }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({} as never);
    mocks.setting.mockImplementation(async (key: string) => ({
      settingValue: key === 'cardUnlockEnabled' ? 'false' : '17',
    }));
    mocks.retrieve.mockResolvedValue({
      id: row.setupIntentId,
      customer: row.customerId,
      livemode: false,
      status,
      metadata: { verificationId: row.verificationId, purpose: 'card_verification', environment: 'test' },
    });
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(CardVerification.updateOne).not.toHaveBeenCalledWith(expect.anything(), { $set: { state: 'refused' } });
  });
  it('cleans up a committed default-detach grant even with the offer disabled', async () => {
    vi.spyOn(CardVerification, 'findOne').mockReturnValue({
      lean: async () => ({
        state: 'granted',
        saveCard: false,
        notifiedAt: new Date(),
      }),
    } as never);
    mocks.setting.mockRejectedValue(new Error('policy unavailable'));
    expect(await finishCardVerification('synthetic-verification', 'synthetic-user')).toBe('already_granted');
    expect(mocks.remove).toHaveBeenCalledWith('synthetic-verification', 'synthetic-user', expect.any(Object));
    expect(mocks.setting).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
  });
  it('fails closed without private policy or active challenge', async () => {
    vi.stubEnv('CARD_VERIFICATION_DEFENSE_POLICY', '');
    expect(await (await cardVerificationRuntime()).policy()).toMatchObject({ enabled: false });
    expect(mocks.account).not.toHaveBeenCalled();
    vi.stubEnv('CARD_VERIFICATION_DEFENSE_POLICY', JSON.stringify(defense));
    mocks.challenge.mockResolvedValue({ active: false });
    expect(await (await cardVerificationRuntime()).policy()).toMatchObject({ enabled: false });
  });
  it('binds the attestation to the current Stripe account', async () => {
    mocks.account.mockResolvedValue({ id: 'acct_other' });
    expect(await (await cardVerificationRuntime()).policy()).toMatchObject({ enabled: false });
  });
  it('refuses missing indexes or unavailable recovery', async () => {
    vi.mocked(CardVerificationFailure.collection.listIndexes).mockReturnValue({ toArray: async () => [] } as never);
    await expect(cardVerificationRuntime()).rejects.toThrow('storage is not ready');
    vi.stubEnv('CARD_VERIFICATION_RECOVERY_ENABLED', '');
    expect(await (await cardVerificationRuntime()).policy()).toMatchObject({ enabled: false });
  });
  it('consumes shared account/IP/ASN limits and verifies action and hostname', async () => {
    const runtime = await cardVerificationRuntime();
    await runtime.guards!.authorizeAttempt(context);
    expect(mocks.limit).toHaveBeenCalledTimes(3);
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAction: 'card_verification',
        requireAllowedHostnames: true,
        allowedHostnames: ['example.test'],
      })
    );
    expect(mocks.limit.mock.calls.map(call => call[0]).join(' ')).not.toContain(context.ip);
  });
  it('rejects unknown network, lockout, exhausted counter and unavailable challenge', async () => {
    const runtime = await cardVerificationRuntime();
    await expect(runtime.guards!.authorizeAttempt({ ...context, asn: '' })).rejects.toThrow('trusted network');
    vi.mocked(CardVerificationFailure.countDocuments).mockResolvedValueOnce(2);
    await expect(runtime.guards!.authorizeAttempt(context)).rejects.toThrow('locked');
    mocks.limit.mockResolvedValueOnce({ success: false });
    await expect(runtime.guards!.authorizeAttempt(context)).rejects.toThrow('Too many');
  });
  it('verifies the challenge before spending any shared attempt counter', async () => {
    const runtime = await cardVerificationRuntime();
    mocks.verify.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await expect(runtime.guards!.authorizeAttempt(context)).rejects.toThrow('Verification failed');
    expect(mocks.limit).not.toHaveBeenCalled();
  });
  it('records each signed attempt once and never resets daily failure identity', async () => {
    vi.spyOn(CardVerificationFailure, 'updateOne').mockResolvedValue({ upsertedCount: 0 } as never);
    const runtime = await cardVerificationRuntime();
    await runtime.guards!.recordFailure(
      { id: 'seti_synthetic', latest_attempt: 'setatt_synthetic' } as Stripe.SetupIntent,
      {
        verificationId: 'synthetic',
        userId: 'synthetic-user',
        environment: 'test',
        livemode: false,
        credits: 17,
        saveCard: false,
        state: 'pending',
        detached: false,
        ipDigest: 'a'.repeat(64),
      }
    );
    expect(CardVerificationFailure.updateOne).toHaveBeenCalledWith(
      { attemptId: 'setatt_synthetic' },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ userId: 'synthetic-user' }) }),
      { upsert: true }
    );
  });
  it('reports lease contention as busy instead of failing the caller', async () => {
    mocks.lease.mockResolvedValue(false);
    const findOne = vi.spyOn(CardVerification, 'findOne');
    expect(await finishCardVerification('synthetic-verification', 'synthetic-user')).toBe('busy');
    expect(findOne).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('detaches a succeeded default-detach card without granting while the offer is disabled', async () => {
    const row = {
      verificationId: 'synthetic',
      userId: 'synthetic-user',
      state: 'pending',
      environment: 'test',
      livemode: false,
      saveCard: false,
      customerId: 'cus_synthetic',
      setupIntentId: 'seti_synthetic',
      createdAt: new Date(),
    };
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [row] }) }),
    } as never);
    vi.spyOn(CardVerification, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    mocks.setting.mockImplementation(async (key: string) => ({
      settingValue: key === 'cardUnlockEnabled' ? 'false' : '17',
    }));
    mocks.retrieve.mockResolvedValue({
      id: row.setupIntentId,
      customer: row.customerId,
      livemode: false,
      status: 'succeeded',
      payment_method: 'pm_synthetic',
      metadata: { verificationId: row.verificationId, purpose: 'card_verification', environment: 'test' },
    });
    await expect(reconcileCardVerifications()).resolves.toBeUndefined();
    expect(CardVerification.updateOne).toHaveBeenCalledWith(
      { verificationId: 'synthetic', state: 'pending' },
      { $set: { state: 'refused', paymentMethodId: 'pm_synthetic' } }
    );
    expect(mocks.remove).toHaveBeenCalledWith('synthetic', 'synthetic-user', expect.any(Object));
    expect(CardVerification.updateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ state: 'verified' }) })
    );
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it('shares one per-IP counter across an IPv6 /64', async () => {
    expect(cardNetworkDigest('2001:db8::1')).toBe(cardNetworkDigest('2001:db8::ffff:2'));
    expect(cardNetworkDigest('2001:db8::1')).not.toBe(cardNetworkDigest('2001:db8:0:1::1'));
    const runtime = await cardVerificationRuntime();
    await runtime.guards!.authorizeAttempt({ ...context, ip: '2001:db8::1' });
    await runtime.guards!.authorizeAttempt({ ...context, ip: '2001:db8::ffff:2' });
    const ipKeys = mocks.limit.mock.calls.map(call => String(call[0])).filter(key => key.includes(':ip:'));
    expect(ipKeys).toHaveLength(2);
    expect(ipKeys[0]).toBe(ipKeys[1]);
  });
  it('memoizes the account attestation and index check across offer reads', async () => {
    await cardVerificationRuntime();
    await cardVerificationRuntime();
    expect(mocks.account).toHaveBeenCalledTimes(1);
    expect(CardVerification.collection.listIndexes).toHaveBeenCalledTimes(1);
  });
  it('logs an unavailable runtime and serves a disabled offer', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    mocks.setting.mockRejectedValue(new Error('synthetic settings outage'));
    vi.spyOn(CardVerification, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    } as never);
    mocks.grantLookup.mockResolvedValue(null);
    expect(await verificationOffer('synthetic-user')).toMatchObject({ available: false, siteKey: '' });
    expect(warn).toHaveBeenCalledWith('card-verification-offer-unavailable', {
      reason: 'synthetic settings outage',
    });
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it('explains an ineligible account to the user', () => {
    expect(verificationFailure(new CardVerificationRefused('ineligible'))).toEqual({
      status: 403,
      error: 'This account is not eligible for the card verification offer.',
    });
  });
  it('explains a card that is still in use instead of blaming the account', () => {
    expect(verificationFailure(new CardVerificationRefused('card_in_use'))).toEqual({
      status: 409,
      error: 'This card is in use as a payment method, so it cannot be removed here.',
    });
  });
});
