import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE,
  CreditHolderType,
  TOKEN_RATE_LIMIT_EXCEEDED_ERROR_CODE,
  TooManyRequestsError,
} from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  resolveTrust: vi.fn(),
  userTokensSince: vi.fn(),
  tryAcquireLease: vi.fn(),
  releaseLease: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({ userApiKeyService: { loadApiKeyTrustSettings: mocks.loadSettings } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryAcquireLease: mocks.tryAcquireLease, releaseLease: mocks.releaseLease },
  usageEventRepository: { userTokensSince: mocks.userTokensSince },
  User: { findById: mocks.findUser },
}));
vi.mock('@server/utils/apiKeyTrust', () => ({ resolveApiKeyTrust: mocks.resolveTrust }));

import type { Request } from 'express';
import {
  admitApiKeyCompletion,
  admitRequestCompletion,
  completionSlotsKey,
  NO_COMPLETION_QUOTA,
} from './untrustedCompletionQuota';

const owner = {
  id: 'user-1',
  isAdmin: false,
  emailVerified: true,
  apiKeyTrustApproved: false,
  lastCreditsPurchasedAt: null,
  createdAt: new Date(),
};

const settings = (overrides: Record<string, unknown> = {}) => ({
  gateEnabled: true,
  minAccountAgeDays: 7,
  maxActiveKeysUntrusted: 1,
  untrustedRateLimitPerMinute: 20,
  untrustedRequestsPerDay: 0,
  untrustedTokensPerMinute: 1000,
  untrustedMaxConcurrent: 2,
  ...overrides,
});

const untrusted = { assessment: { status: 'untrusted', reason: 'not_yet_trusted' } };

async function rejectionOf(promise: Promise<unknown>): Promise<TooManyRequestsError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TooManyRequestsError);
  return error as TooManyRequestsError;
}

describe('admitApiKeyCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSettings.mockResolvedValue(settings());
    mocks.resolveTrust.mockResolvedValue(untrusted);
    mocks.userTokensSince.mockResolvedValue({ tokens: 0 });
    mocks.tryAcquireLease.mockResolvedValue(true);
    mocks.releaseLease.mockResolvedValue(undefined);
  });

  it('passes org-billed keys without reading settings', async () => {
    const grant = await admitApiKeyCompletion({
      owner,
      billingOwnerType: CreditHolderType.Organization,
      holdSlot: true,
    });
    expect(grant).toBe(NO_COMPLETION_QUOTA);
    expect(mocks.loadSettings).not.toHaveBeenCalled();
  });

  it('skips the trust lookup when every quota is off', async () => {
    mocks.loadSettings.mockResolvedValue(settings({ untrustedTokensPerMinute: 0, untrustedMaxConcurrent: 0 }));
    expect(await admitApiKeyCompletion({ owner, holdSlot: true })).toBe(NO_COMPLETION_QUOTA);
    expect(mocks.resolveTrust).not.toHaveBeenCalled();
  });

  it('skips everything when the trust gate is off', async () => {
    mocks.loadSettings.mockResolvedValue(settings({ gateEnabled: false }));
    expect(await admitApiKeyCompletion({ owner, holdSlot: true })).toBe(NO_COMPLETION_QUOTA);
    expect(mocks.resolveTrust).not.toHaveBeenCalled();
  });

  it('leaves a trusted owner untouched even when over both quotas', async () => {
    mocks.resolveTrust.mockResolvedValue({ assessment: { status: 'trusted' } });
    mocks.userTokensSince.mockResolvedValue({ tokens: 10_000 });
    mocks.tryAcquireLease.mockResolvedValue(false);
    expect(await admitApiKeyCompletion({ owner, holdSlot: true })).toBe(NO_COMPLETION_QUOTA);
    expect(mocks.userTokensSince).not.toHaveBeenCalled();
    expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
  });

  it('loads the owner when only an id is given', async () => {
    mocks.findUser.mockResolvedValue(owner);
    await admitApiKeyCompletion({ owner: 'user-1', holdSlot: false });
    expect(mocks.findUser).toHaveBeenCalledWith('user-1');
    expect(mocks.resolveTrust).toHaveBeenCalledWith(owner, undefined);
  });

  it('trusts the standing auth already judged instead of re-judging the owner', async () => {
    mocks.userTokensSince.mockResolvedValue({ tokens: 1000 });
    await rejectionOf(admitApiKeyCompletion({ owner: 'user-1', ownerUntrusted: true, holdSlot: false }));
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.resolveTrust).not.toHaveBeenCalled();
    expect(mocks.userTokensSince.mock.calls[0][0]).toBe('user-1');
  });

  it('passes an owner auth judged trusted without reading settings', async () => {
    expect(await admitApiKeyCompletion({ owner: 'user-1', ownerUntrusted: false, holdSlot: true })).toBe(
      NO_COMPLETION_QUOTA
    );
    expect(mocks.loadSettings).not.toHaveBeenCalled();
  });

  describe('admitRequestCompletion', () => {
    it('passes a request no API key authenticated', async () => {
      expect(await admitRequestCompletion({ user: owner } as unknown as Request, { holdSlot: true })).toBe(
        NO_COMPLETION_QUOTA
      );
      expect(mocks.loadSettings).not.toHaveBeenCalled();
    });

    it("admits an API-key request against its owner and the key's billing owner", async () => {
      const req = { user: owner, apiKeyInfo: { keyId: 'k1', billingOwnerType: CreditHolderType.User } };
      await admitRequestCompletion(req as unknown as Request, { holdSlot: true });
      expect(mocks.resolveTrust).toHaveBeenCalledWith(owner, req);
      expect(mocks.tryAcquireLease).toHaveBeenCalled();
    });
  });

  describe('tokens per minute', () => {
    it('admits an untrusted owner under the limit', async () => {
      mocks.userTokensSince.mockResolvedValue({ tokens: 999, oldestAt: new Date() });
      await expect(admitApiKeyCompletion({ owner, holdSlot: false })).resolves.toBeDefined();
      const [userId, since] = mocks.userTokensSince.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(Date.now() - (since as Date).getTime()).toBeGreaterThanOrEqual(60_000);
    });

    it('refuses with a 429, its code and the seconds until the window drains', async () => {
      mocks.userTokensSince.mockResolvedValue({ tokens: 1000, oldestAt: new Date(Date.now() - 45_000) });
      const error = await rejectionOf(admitApiKeyCompletion({ owner, holdSlot: true }));
      expect(error.statusCode).toBe(429);
      expect(error.additionalInfo).toMatchObject({ errorCode: TOKEN_RATE_LIMIT_EXCEEDED_ERROR_CODE });
      const retryAfter = error.additionalInfo?.retryAfter as number;
      expect(retryAfter).toBeGreaterThanOrEqual(14);
      expect(retryAfter).toBeLessThanOrEqual(16);
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });
  });

  describe('concurrent completions', () => {
    it('takes a slot on the account lease and frees exactly that slot once', async () => {
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      const [key, holderId, limit] = mocks.tryAcquireLease.mock.calls[0];
      expect(key).toBe(completionSlotsKey('user-1'));
      expect(limit).toBe(2);

      await Promise.all([grant.release(), grant.release()]);
      await grant.release();

      expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
      expect(mocks.releaseLease).toHaveBeenCalledWith(key, holderId);
    });

    it('refuses with a 429 and its code when every slot is taken', async () => {
      mocks.tryAcquireLease.mockResolvedValue(false);
      const error = await rejectionOf(admitApiKeyCompletion({ owner, holdSlot: true }));
      expect(error.additionalInfo).toMatchObject({ errorCode: CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE });
    });

    it('takes no slot when the caller does not hold one for the completion', async () => {
      expect(await admitApiKeyCompletion({ owner, holdSlot: false })).toBe(NO_COMPLETION_QUOTA);
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('swallows a failed release, leaving the lease to lapse', async () => {
      mocks.releaseLease.mockRejectedValue(new Error('db down'));
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await expect(grant.release()).resolves.toBeUndefined();
    });
  });
});
