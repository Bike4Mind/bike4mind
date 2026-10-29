import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  renewLease: vi.fn(),
  findUser: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn: mocks.warn } } }));

vi.mock('@bike4mind/services', () => ({ userApiKeyService: { loadApiKeyTrustSettings: mocks.loadSettings } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: {
    tryAcquireLease: mocks.tryAcquireLease,
    releaseLease: mocks.releaseLease,
    renewLease: mocks.renewLease,
  },
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.renewLease.mockResolvedValue(true);
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

    it('preserves the authenticated trust judgment after the admin role is withheld', async () => {
      const req = {
        user: { ...owner, isAdmin: false },
        apiKeyInfo: { keyId: 'k1', billingOwnerType: CreditHolderType.User, ownerUntrusted: false },
      };
      expect(await admitRequestCompletion(req as unknown as Request, { holdSlot: true })).toBe(NO_COMPLETION_QUOTA);
      expect(mocks.resolveTrust).not.toHaveBeenCalled();
      expect(mocks.loadSettings).not.toHaveBeenCalled();
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('forwards an untrusted auth judgment without resolving trust again', async () => {
      const req = {
        user: owner,
        apiKeyInfo: { keyId: 'k1', billingOwnerType: CreditHolderType.User, ownerUntrusted: true },
      };
      await admitRequestCompletion(req as unknown as Request, { holdSlot: true });
      expect(mocks.resolveTrust).not.toHaveBeenCalled();
      expect(mocks.tryAcquireLease).toHaveBeenCalled();
    });

    it("admits an API-key request against its owner and the key's billing owner", async () => {
      const req = { user: owner, apiKeyInfo: { keyId: 'k1', billingOwnerType: CreditHolderType.User } };
      await admitRequestCompletion(req as unknown as Request, { holdSlot: true });
      expect(mocks.resolveTrust).toHaveBeenCalledWith(owner, req);
      expect(mocks.tryAcquireLease).toHaveBeenCalled();
    });
  });

  describe('admission infrastructure failures', () => {
    it('rejects when quota settings cannot be read', async () => {
      const error = new Error('settings unavailable');
      mocks.loadSettings.mockRejectedValueOnce(error);
      await expect(admitApiKeyCompletion({ owner, holdSlot: true })).rejects.toBe(error);
      expect(mocks.userTokensSince).not.toHaveBeenCalled();
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('rejects when the owner trust check fails', async () => {
      const error = new Error('subscriptions unavailable');
      mocks.resolveTrust.mockRejectedValueOnce(error);
      await expect(admitApiKeyCompletion({ owner, holdSlot: true })).rejects.toBe(error);
      expect(mocks.userTokensSince).not.toHaveBeenCalled();
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('rejects a failed token ledger read instead of assuming zero usage', async () => {
      const error = new Error('ledger unavailable');
      mocks.userTokensSince.mockRejectedValueOnce(error);
      await expect(admitApiKeyCompletion({ owner, holdSlot: true })).rejects.toBe(error);
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });

    it('rejects a failed lease acquisition instead of admitting without a slot', async () => {
      const error = new Error('semaphore unavailable');
      mocks.tryAcquireLease.mockRejectedValueOnce(error);
      await expect(admitApiKeyCompletion({ owner, holdSlot: true })).rejects.toBe(error);
      expect(mocks.renewLease).not.toHaveBeenCalled();
      expect(mocks.releaseLease).not.toHaveBeenCalled();
    });
  });

  describe('tokens per minute', () => {
    it('admits an untrusted owner under the limit', async () => {
      const now = Date.UTC(2026, 9, 27, 0, 0, 0);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mocks.userTokensSince.mockResolvedValue({ tokens: 999, oldestAt: new Date(now) });
      await expect(admitApiKeyCompletion({ owner, holdSlot: false })).resolves.toBeDefined();
      const [userId, since] = mocks.userTokensSince.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(since).toEqual(new Date(now - 60_000));
    });

    it('refuses with a 429, its code and the seconds until the window drains', async () => {
      const now = Date.UTC(2026, 9, 27, 0, 0, 0);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mocks.userTokensSince.mockResolvedValue({ tokens: 1000, oldestAt: new Date(now - 45_000) });
      const error = await rejectionOf(admitApiKeyCompletion({ owner, holdSlot: true }));
      expect(error.statusCode).toBe(429);
      expect(error.additionalInfo).toMatchObject({ errorCode: TOKEN_RATE_LIMIT_EXCEEDED_ERROR_CODE });
      const retryAfter = error.additionalInfo?.retryAfter as number;
      expect(retryAfter).toBe(15);
      expect(mocks.tryAcquireLease).not.toHaveBeenCalled();
    });
  });

  describe('concurrent completions', () => {
    it('enforces concurrency independently when token metering is disabled', async () => {
      mocks.loadSettings.mockResolvedValue(settings({ untrustedTokensPerMinute: 0, untrustedMaxConcurrent: 2 }));
      mocks.tryAcquireLease.mockResolvedValueOnce(false);

      const error = await rejectionOf(admitApiKeyCompletion({ owner, holdSlot: true }));
      expect(error.additionalInfo).toMatchObject({ errorCode: CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE });
      expect(mocks.userTokensSince).not.toHaveBeenCalled();
      expect(mocks.tryAcquireLease).toHaveBeenCalledWith(
        completionSlotsKey(owner.id),
        expect.any(String),
        2,
        expect.any(Number)
      );

      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await grant.release();
      expect(mocks.releaseLease).toHaveBeenCalledOnce();
    });

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

    it('renews a running completion past the original lease and stops when released', async () => {
      vi.useFakeTimers();
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      const [key, holderId] = mocks.tryAcquireLease.mock.calls[0];
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(mocks.renewLease).toHaveBeenCalledTimes(4);
      expect(mocks.renewLease).toHaveBeenLastCalledWith(key, holderId, 15 * 60_000);
      await grant.release();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(mocks.renewLease).toHaveBeenCalledTimes(4);
    });

    it('does not overlap renewals or restart one after release while a renewal is pending', async () => {
      vi.useFakeTimers();
      let finishRenewal: (renewed: boolean) => void = () => undefined;
      mocks.renewLease.mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            finishRenewal = resolve;
          })
      );
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(mocks.renewLease).toHaveBeenCalledOnce();
      await grant.release();
      finishRenewal(true);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(mocks.renewLease).toHaveBeenCalledOnce();
    });

    it('logs a renewal failure and retries without an unhandled rejection', async () => {
      vi.useFakeTimers();
      const error = new Error('cache unavailable');
      mocks.renewLease.mockRejectedValueOnce(error);
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mocks.warn).toHaveBeenCalledWith('Failed to renew API completion quota slot', { userId: owner.id, error });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mocks.renewLease).toHaveBeenCalledTimes(2);
      await grant.release();
    });

    it('logs a lost lease without trying to reacquire or resurrect it', async () => {
      vi.useFakeTimers();
      mocks.renewLease.mockResolvedValueOnce(false);
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(mocks.warn).toHaveBeenCalledWith('API completion quota slot expired before renewal', { userId: owner.id });
      expect(mocks.renewLease).toHaveBeenCalledOnce();
      expect(mocks.tryAcquireLease).toHaveBeenCalledOnce();
      await grant.release();
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

    it('logs a failed release, leaving the lease to lapse', async () => {
      const error = new Error('db down');
      mocks.releaseLease.mockRejectedValue(error);
      const grant = await admitApiKeyCompletion({ owner, holdSlot: true });
      await expect(grant.release()).resolves.toBeUndefined();
      expect(mocks.warn).toHaveBeenCalledWith('Failed to release API completion quota slot; waiting for lease expiry', {
        userId: owner.id,
        error,
      });
    });
  });
});
