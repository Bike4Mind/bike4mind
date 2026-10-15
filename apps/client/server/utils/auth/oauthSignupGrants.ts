import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';
import type { SeatCeilingRaiseTrigger } from '@server/organizations/notifySeatCeilingRaised';

/**
 * Signup/link-time grants for the OAuth callbacks (verifyCallback.ts for Google/GitHub/SAML,
 * pages/api/auth/okta/callback.ts for Okta). Every function here is best-effort and never throws:
 * a grant failure must never fail a login.
 */

type PendingFreeCreditUser = { id: string; tags?: readonly string[] | null; pendingCreditGrant?: number | null };

/**
 * Whether a brand-new self-serve OAuth account should carry the deferred flat grant. Applies the
 * same disposable-email gate as registerUser. A settings read failure withholds the grant.
 */
export async function isEligibleForOAuthFreeCredits(email: string): Promise<boolean> {
  try {
    return !(await userService.shouldBlockDisposableEmail(email, { adminSettings: adminSettingsRepository }));
  } catch (error) {
    Logger.globalInstance.error('OAuth signup free-credit eligibility check failed; withholding the grant', error);
    return false;
  }
}

/**
 * Release a PENDING_FREE_CREDITS_TAG grant now that the provider has attested the email, and persist
 * the tag removal. No-op for an untagged user. On failure the tag stays for the
 * backfillPendingFreeCredits script.
 */
export async function releaseOAuthPendingFreeCredits(user: PendingFreeCreditUser, reason: string): Promise<void> {
  const logger = Logger.globalInstance;
  try {
    const release = await userService.releasePendingFreeCredits(
      { id: user.id, tags: user.tags ? [...user.tags] : null, pendingCreditGrant: user.pendingCreditGrant ?? null },
      {
        db: {
          adminSettings: adminSettingsRepository,
          creditTransactions: creditTransactionRepository,
          creditLots: creditLotRepository,
          users: userRepository,
        },
        reason,
        logger,
      }
    );
    if (release.released) await userRepository.update({ id: user.id, ...release.patch });
  } catch (error) {
    logger.error(`OAuth pending free-credit release failed for user ${user.id}`, error);
  }
}

/** The verified email's domain grant (credits, partner org membership) for a new OAuth account. */
export async function applyOAuthSignupDomainGrant(userId: string, email: string): Promise<void> {
  await applyDomainGrantSafely(userId, email, 'oauth-signup');
}

/**
 * Grants for an account link that promotes emailVerified. The promotion IS this account's email
 * verification, and once it is set the account never reaches /api/email/verify, so everything that
 * route grants happens here: the deferred flat grant and the verified domain's grant. Must stay in
 * sync with pages/api/email/verify.ts and the existing-user branch of pages/api/otc/verify.ts.
 */
export async function applyOAuthLinkVerificationGrants(
  user: PendingFreeCreditUser,
  verifiedEmail: string,
  reason: string
): Promise<void> {
  await releaseOAuthPendingFreeCredits(user, reason);
  await applyDomainGrantSafely(user.id, verifiedEmail, 'oauth-link-verification');
}

async function applyDomainGrantSafely(userId: string, email: string, trigger: SeatCeilingRaiseTrigger): Promise<void> {
  try {
    await applySignupDomainGrant({ userId, email, trigger, logger: Logger.globalInstance });
  } catch (error) {
    Logger.globalInstance.error(`OAuth domain grant (${trigger}) failed for user ${userId}`, error);
  }
}
