import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

const mockUserUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: { update: (...a: unknown[]) => mockUserUpdate(...a) },
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

const mockLoggerError = vi.fn();
vi.mock('@bike4mind/observability', () => ({
  Logger: { globalInstance: { error: (...a: unknown[]) => mockLoggerError(...a) } },
}));

import {
  applyOAuthLinkVerificationGrants,
  applyOAuthSignupDomainGrant,
  isEligibleForOAuthFreeCredits,
  releaseOAuthPendingFreeCredits,
} from './oauthSignupGrants';

describe('oauthSignupGrants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserUpdate.mockResolvedValue(undefined);
  });

  describe('isEligibleForOAuthFreeCredits', () => {
    it('is the inverse of the shared disposable-email gate', async () => {
      mockShouldBlock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await isEligibleForOAuthFreeCredits('x@mailinator.com')).toBe(false);
      expect(await isEligibleForOAuthFreeCredits('x@gmail.com')).toBe(true);
    });

    it('withholds the grant when the gate throws', async () => {
      mockShouldBlock.mockRejectedValue(new Error('settings down'));
      expect(await isEligibleForOAuthFreeCredits('x@gmail.com')).toBe(false);
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('releaseOAuthPendingFreeCredits', () => {
    it('persists the release patch', async () => {
      mockReleasePending.mockResolvedValue({
        released: true,
        creditsGranted: 100,
        currentCredits: 100,
        patch: { tags: [], pendingCreditGrant: null },
      });

      await releaseOAuthPendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, 'test');

      expect(mockReleasePending).toHaveBeenCalledWith(
        { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null },
        expect.objectContaining({ reason: 'test' })
      );
      expect(mockUserUpdate).toHaveBeenCalledWith({ id: 'user-1', tags: [], pendingCreditGrant: null });
    });

    it('writes nothing when nothing was released, so the tag stays for the backfill', async () => {
      mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });

      await releaseOAuthPendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, 'test');

      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('logs with the user id and never throws when the write fails', async () => {
      mockReleasePending.mockResolvedValue({
        released: true,
        creditsGranted: 100,
        currentCredits: 100,
        patch: { tags: [], pendingCreditGrant: null },
      });
      mockUserUpdate.mockRejectedValue(new Error('db down'));

      await expect(
        releaseOAuthPendingFreeCredits({ id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] }, 'test')
      ).resolves.toBeUndefined();
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
    });
  });

  describe('applyOAuthSignupDomainGrant', () => {
    it('runs the shared domain grant with the oauth-signup trigger', async () => {
      await applyOAuthSignupDomainGrant('user-1', 'dee@partner.example');

      expect(mockApplySignupDomainGrant).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', email: 'dee@partner.example', trigger: 'oauth-signup' })
      );
    });

    it('logs with the user id and never throws', async () => {
      mockApplySignupDomainGrant.mockRejectedValue(new Error('boom'));

      await expect(applyOAuthSignupDomainGrant('user-1', 'dee@partner.example')).resolves.toBeUndefined();
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
    });
  });

  describe('applyOAuthLinkVerificationGrants', () => {
    const linkedUser = { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG] };

    it('releases the pending credits and applies the domain grant with the email-verification trigger', async () => {
      mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });

      await applyOAuthLinkVerificationGrants(linkedUser, 'dee@partner.example', 'link test');

      expect(mockReleasePending).toHaveBeenCalledWith(
        { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: null },
        expect.objectContaining({ reason: 'link test' })
      );
      expect(mockApplySignupDomainGrant).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', email: 'dee@partner.example', trigger: 'email-verification' })
      );
    });

    it('logs with the user id and never throws when the domain grant fails', async () => {
      mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });
      mockApplySignupDomainGrant.mockRejectedValue(new Error('boom'));

      await expect(
        applyOAuthLinkVerificationGrants(linkedUser, 'dee@partner.example', 'link test')
      ).resolves.toBeUndefined();
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
    });

    it('still applies the domain grant when the pending-credit release fails', async () => {
      mockReleasePending.mockRejectedValue(new Error('release down'));

      await expect(
        applyOAuthLinkVerificationGrants(linkedUser, 'dee@partner.example', 'link test')
      ).resolves.toBeUndefined();
      expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(Error));
      expect(mockApplySignupDomainGrant).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', trigger: 'email-verification' })
      );
    });
  });
});
