import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));

const mockClearPending = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  grantPackageRepository: { releaseRedemption: vi.fn() },
  userRepository: { clearPendingFreeCreditGrant: (...a: unknown[]) => mockClearPending(...a) },
}));

const mockReleasePending = vi.fn();
const mockShouldBlock = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    releasePendingFreeCredits: (...a: unknown[]) => mockReleasePending(...a),
    shouldBlockDisposableEmail: (...a: unknown[]) => mockShouldBlock(...a),
  },
}));

import { signupProtection } from './signupProtection';
import { isEligibleForFreeCredits, releaseVerifiedPendingFreeCredits } from './pendingFreeCredits';

const mockLoggerError = vi.fn();
const logger = { info: vi.fn(), error: (...a: unknown[]) => mockLoggerError(...a) } as unknown as Logger;

const taggedUser = { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG, 'Customer'], pendingCreditGrant: 100 };
const releasedResult = {
  released: true,
  creditsGranted: 100,
  currentCredits: 100,
  patch: { tags: ['Customer'], pendingCreditGrant: null },
};

describe('pendingFreeCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearPending.mockResolvedValue({ tags: ['Customer'] });
  });

  describe('isEligibleForFreeCredits', () => {
    it('is the inverse of the disposable-email gate', async () => {
      mockShouldBlock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await isEligibleForFreeCredits('x@mailinator.com', logger)).toBe(false);
      expect(await isEligibleForFreeCredits('x@gmail.com', logger)).toBe(true);
    });

    it('passes signupProtection so the gate sees the refreshed reject-tier lists', async () => {
      mockShouldBlock.mockResolvedValue(false);
      await isEligibleForFreeCredits('x@gmail.com', logger);
      expect(mockShouldBlock.mock.calls[0][1].signupProtection).toBe(signupProtection);
    });

    it('withholds the grant when the gate throws', async () => {
      mockShouldBlock.mockRejectedValue(new Error('settings down'));
      expect(await isEligibleForFreeCredits('x@gmail.com', logger)).toBe(false);
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('releaseVerifiedPendingFreeCredits', () => {
    it('writes nothing and reports nothing released for an untagged user', async () => {
      mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });

      const result = await releaseVerifiedPendingFreeCredits({ id: 'user-1', tags: ['Customer'] }, 'test', logger);

      expect(result).toEqual({ creditsGranted: 0, currentCredits: null, tags: null });
      expect(mockClearPending).not.toHaveBeenCalled();
    });

    it('atomically clears the breadcrumb and reports the persisted tags', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);

      const result = await releaseVerifiedPendingFreeCredits(taggedUser, 'test reason', logger);

      expect(mockReleasePending).toHaveBeenCalledWith(
        { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG, 'Customer'], pendingCreditGrant: 100 },
        expect.objectContaining({ reason: 'test reason', logger })
      );
      expect(mockClearPending).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ creditsGranted: 100, currentCredits: 100, tags: ['Customer'] });
    });

    it('forwards bypassBudget to the release adapters', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);

      await releaseVerifiedPendingFreeCredits(taggedUser, 'test reason', logger, undefined, { bypassBudget: true });

      expect(mockReleasePending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ bypassBudget: true })
      );
    });

    it('reports current persisted tags instead of the stale grant snapshot', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);
      mockClearPending.mockResolvedValue({ tags: ['new-entitlement'] });
      const result = await releaseVerifiedPendingFreeCredits(taggedUser, 'review release', logger);
      expect(result.tags).toEqual(['new-entitlement']);
      expect(mockClearPending).toHaveBeenCalledWith('user-1');
    });

    it('logs and resolves with nothing released when the release throws', async () => {
      mockReleasePending.mockRejectedValue(new Error('release down'));

      await expect(releaseVerifiedPendingFreeCredits(taggedUser, 'test', logger)).resolves.toEqual({
        creditsGranted: 0,
        currentCredits: null,
        tags: null,
      });
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
      expect(mockClearPending).not.toHaveBeenCalled();
    });

    it('logs but still reports the credits when the tag-removal write fails', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);
      mockClearPending.mockRejectedValue(new Error('db down'));

      await expect(releaseVerifiedPendingFreeCredits(taggedUser, 'test', logger)).resolves.toEqual({
        creditsGranted: 100,
        currentCredits: 100,
        tags: null,
      });
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
    });
  });
});
