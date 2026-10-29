import { signupProtection } from '@server/auth/signupProtection';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const { refreshSignupRiskScore } = vi.hoisted(() => ({ refreshSignupRiskScore: vi.fn(async () => undefined) }));
vi.mock('@server/auth/signupRiskScore', () => ({ refreshSignupRiskScore }));

const mockClearPending = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
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

const mockApplySignupDomainGrant = vi.fn();
vi.mock('@server/entitlements/signupDomainGrant', () => ({
  applySignupDomainGrant: (...a: unknown[]) => mockApplySignupDomainGrant(...a),
}));

import {
  applyEmailVerifiedGrants,
  isEligibleForFreeCredits,
  releaseVerifiedPendingFreeCredits,
} from './emailVerifiedGrants';

const mockLoggerError = vi.fn();
const logger = { info: vi.fn(), error: (...a: unknown[]) => mockLoggerError(...a) } as unknown as Logger;

const taggedUser = { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG, 'Customer'], pendingCreditGrant: 100 };
const releasedResult = {
  released: true,
  creditsGranted: 100,
  currentCredits: 100,
  patch: { tags: ['Customer'], pendingCreditGrant: null },
};
const NO_DOMAIN_GRANT = { creditsGranted: 0, currentCredits: null, joinedOrganizationId: null, tagsApplied: [] };

describe('emailVerifiedGrants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearPending.mockResolvedValue({ tags: ['Customer'] });
    mockApplySignupDomainGrant.mockResolvedValue(NO_DOMAIN_GRANT);
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

  describe('applyEmailVerifiedGrants', () => {
    const params = {
      user: taggedUser,
      verifiedEmail: 'dee@partner.example',
      trigger: 'email-verification' as const,
      releaseReason: 'verify test',
      logger,
    };

    it('passes the trigger and verified email through to the domain grant', async () => {
      mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });

      await applyEmailVerifiedGrants(params);

      expect(refreshSignupRiskScore).toHaveBeenCalledWith('user-1', logger);

      expect(mockApplySignupDomainGrant).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'dee@partner.example',
        trigger: 'email-verification',
        logger,
      });
      expect(mockReleasePending).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ reason: 'verify test' })
      );
      expect(mockReleasePending.mock.calls[0][1].db.signupProtection).toBe(signupProtection);
    });

    it('sums the credits and prefers the domain grant balance', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);
      mockApplySignupDomainGrant.mockResolvedValue({
        creditsGranted: 50,
        currentCredits: 150,
        joinedOrganizationId: 'org-partner',
        tagsApplied: ['Partner'],
        subscriptionCreditsGranted: 20,
      });

      await expect(applyEmailVerifiedGrants(params)).resolves.toEqual({
        creditsGranted: 150,
        currentCredits: 150,
        tags: ['Customer'],
        joinedOrganizationId: 'org-partner',
        subscriptionCreditsGranted: 20,
        tagsApplied: ['Partner'],
      });
    });

    it('returns the persisted release tags before the partner-tag merge runs', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);

      await applyEmailVerifiedGrants(params);

      expect(mockClearPending.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplySignupDomainGrant.mock.invocationCallOrder[0]
      );
    });

    it('falls back to the release balance when the domain grant grants nothing', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);

      await expect(applyEmailVerifiedGrants(params)).resolves.toEqual({
        creditsGranted: 100,
        currentCredits: 100,
        tags: ['Customer'],
        joinedOrganizationId: null,
        tagsApplied: [],
      });
    });

    it('still applies the domain grant when the release throws', async () => {
      mockReleasePending.mockRejectedValue(new Error('release down'));
      mockApplySignupDomainGrant.mockResolvedValue({
        creditsGranted: 50,
        currentCredits: 50,
        joinedOrganizationId: null,
        tagsApplied: [],
      });

      await expect(applyEmailVerifiedGrants(params)).resolves.toEqual({
        creditsGranted: 50,
        currentCredits: 50,
        tags: null,
        joinedOrganizationId: null,
        tagsApplied: [],
      });
      expect(mockLoggerError).toHaveBeenCalled();
    });

    it('reports the release credits when the tag-removal write fails', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);
      mockClearPending.mockRejectedValue(new Error('db down'));

      const result = await applyEmailVerifiedGrants(params);

      expect(result.creditsGranted).toBe(100);
      // The tag is still persisted, so callers must not reflect its removal.
      expect(result.tags).toBeNull();
      expect(mockApplySignupDomainGrant).toHaveBeenCalled();
    });

    it('logs and keeps the release result when the domain grant throws', async () => {
      mockReleasePending.mockResolvedValue(releasedResult);
      mockApplySignupDomainGrant.mockRejectedValue(new Error('grant down'));

      await expect(applyEmailVerifiedGrants(params)).resolves.toEqual({
        creditsGranted: 100,
        currentCredits: 100,
        tags: ['Customer'],
        joinedOrganizationId: null,
        subscriptionCreditsGranted: 0,
        tagsApplied: [],
      });
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('failed for user user-1'),
        expect.any(Error)
      );
    });
  });
});
