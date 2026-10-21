import { Logger } from '@bike4mind/observability';
import { applySignupDomainGrant, type SignupDomainGrantResult } from '@server/entitlements/signupDomainGrant';

const NO_GRANT: SignupDomainGrantResult = {
  creditsGranted: 0,
  currentCredits: null,
  joinedOrganizationId: null,
  tagsApplied: [],
  subscriptionCreditsGranted: 0,
  subscriptionGranted: false,
};

/**
 * The verified email's domain grant (credits, partner org membership, tags) for a brand-new OAuth account.
 * Best-effort and never throws: a grant failure must never fail a login. The grants an account link
 * earns when it promotes emailVerified come straight from server/auth/emailVerifiedGrants.ts.
 */
export async function applyOAuthSignupDomainGrant(userId: string, email: string): Promise<SignupDomainGrantResult> {
  try {
    return await applySignupDomainGrant({ userId, email, trigger: 'oauth-signup', logger: Logger.globalInstance });
  } catch (error) {
    Logger.globalInstance.error(`OAuth signup domain grant failed for user ${userId}`, error);
    return { ...NO_GRANT, tagsApplied: [] };
  }
}
