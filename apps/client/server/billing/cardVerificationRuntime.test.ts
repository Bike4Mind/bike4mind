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
}));
vi.mock('@bike4mind/database', async () => ({
  mongoose: (await import('mongoose')).default,
  adminSettingsRepository: { findBySettingName: mocks.setting },
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: mocks.limit,
    tryAcquireLease: mocks.lease,
    releaseLease: mocks.release,
  },
  creditTransactionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: {} }));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: {} }));
vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: mocks.challenge,
  turnstileAllowedHostnames: () => ['example.test'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({ verifyTurnstile: mocks.verify }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'test' }, isProduction: () => false }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: { accounts: { retrieve: mocks.account }, setupIntents: { retrieve: mocks.retrieve, cancel: mocks.cancel } },
}));
import { CardVerificationFailure, cardVerificationRuntime } from './cardVerificationRuntime';
import { finishCardVerification } from './cardVerificationRuntime';
vi.mock('./cardVerificationLifecycle', async importOriginal => ({
  ...(await importOriginal<typeof import('./cardVerificationLifecycle')>()),
  removeVerificationCard: mocks.remove,
}));
import { CardVerification } from './cardVerificationModel';

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
  vi.stubEnv('CARD_VERIFICATION_IDENTITY_KEY', 'synthetic-key-'.repeat(4));
  vi.stubEnv('CARD_VERIFICATION_RECOVERY_ENABLED', 'true');
  vi.stubEnv('CARD_VERIFICATION_WEBHOOK_SECRET', 'whsec_synthetic');
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
    mocks.verify.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await expect(runtime.guards!.authorizeAttempt(context)).rejects.toThrow('Verification failed');
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
});
