import { Logger } from '@bike4mind/observability';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';

/**
 * The verified email's domain grant (credits, partner org membership) for a brand-new OAuth account.
 * Best-effort and never throws: a grant failure must never fail a login. The grants an account link
 * earns when it promotes emailVerified come straight from server/auth/emailVerifiedGrants.ts.
 */
export async function applyOAuthSignupDomainGrant(userId: string, email: string): Promise<void> {
  try {
    await applySignupDomainGrant({ userId, email, trigger: 'oauth-signup', logger: Logger.globalInstance });
  } catch (error) {
    Logger.globalInstance.error(`OAuth signup domain grant failed for user ${userId}`, error);
  }
}
