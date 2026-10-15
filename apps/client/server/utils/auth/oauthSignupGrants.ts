import { Logger } from '@bike4mind/observability';
import {
  applyEmailVerifiedGrants,
  isEligibleForFreeCredits,
  releaseVerifiedPendingFreeCredits,
  type PendingFreeCreditUser,
} from '@server/auth/emailVerifiedGrants';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';

/**
 * Signup/link-time grants for the OAuth callbacks (verifyCallback.ts for Google/GitHub/SAML,
 * pages/api/auth/okta/callback.ts for Okta). Every function here is best-effort and never throws:
 * a grant failure must never fail a login.
 */

/**
 * Whether a brand-new self-serve OAuth account should carry the deferred flat grant. Applies the
 * same disposable-email gate as registerUser. A settings read failure withholds the grant.
 */
export async function isEligibleForOAuthFreeCredits(email: string): Promise<boolean> {
  return isEligibleForFreeCredits(email, Logger.globalInstance);
}

/**
 * Release a PENDING_FREE_CREDITS_TAG grant now that the provider has attested the email, and persist
 * the tag removal. No-op for an untagged user.
 */
export async function releaseOAuthPendingFreeCredits(user: PendingFreeCreditUser, reason: string): Promise<void> {
  await releaseVerifiedPendingFreeCredits(user, reason, Logger.globalInstance);
}

/** The verified email's domain grant (credits, partner org membership) for a new OAuth account. */
export async function applyOAuthSignupDomainGrant(userId: string, email: string): Promise<void> {
  try {
    await applySignupDomainGrant({ userId, email, trigger: 'oauth-signup', logger: Logger.globalInstance });
  } catch (error) {
    Logger.globalInstance.error(`OAuth signup domain grant failed for user ${userId}`, error);
  }
}

/**
 * Grants for an account link that promotes emailVerified. The promotion IS this account's email
 * verification, so it earns what any verification does (see server/auth/emailVerifiedGrants.ts).
 */
export async function applyOAuthLinkVerificationGrants(
  user: PendingFreeCreditUser,
  verifiedEmail: string,
  reason: string
): Promise<void> {
  await applyEmailVerifiedGrants({
    user,
    verifiedEmail,
    trigger: 'oauth-link-verification',
    releaseReason: reason,
    logger: Logger.globalInstance,
  });
}
