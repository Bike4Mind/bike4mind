import type { Logger } from '@bike4mind/observability';
import { refreshSignupRiskScore } from '@server/auth/signupRiskScore';
import { requestRiskEvidenceRefresh } from '@bike4mind/server-utils/auth/riskEvidence';
import { applySignupDomainGrant, type SignupDomainGrantResult } from '@server/entitlements/signupDomainGrant';
import type { SeatCeilingRaiseTrigger } from '@server/organizations/notifySeatCeilingRaised';
import {
  releaseVerifiedPendingFreeCredits,
  type PendingFreeCreditUser,
  type PendingFreeCreditReleaseResult,
} from '@bike4mind/server-utils/auth/pendingFreeCredits';

// Re-exported so the other client importers keep their import path.
export {
  isEligibleForFreeCredits,
  releaseVerifiedPendingFreeCredits,
} from '@bike4mind/server-utils/auth/pendingFreeCredits';
export type {
  PendingFreeCreditUser,
  PendingFreeCreditReleaseResult,
} from '@bike4mind/server-utils/auth/pendingFreeCredits';

/**
 * The grants an EXISTING account earns the moment its email is proven. Every path that flips
 * emailVerified on an existing account goes through here (/api/email/verify, OTC login, the
 * OAuth/Okta promote-and-link, admin verify; email change takes the flat release only, see
 * verify-change.ts), because once the flag is set nothing prompts the user to verify again: a path
 * that skips a grant loses it for good.
 *
 * Call only AFTER emailVerified is persisted: partner org membership re-reads it. Nothing here
 * throws, and both grants are idempotent per user (stable transactionIds), so a retry or a second
 * path cannot double-apply.
 */

export type EmailVerifiedGrantsResult = PendingFreeCreditReleaseResult & {
  /** The partner org the user was just added to; null when no membership was added. */
  joinedOrganizationId: string | null;
  /** Plan credits from the domain grant; not part of `creditsGranted`. */
  subscriptionCreditsGranted: number;
  /** Partner-rule tags merged into the user AFTER `tags` was persisted; callers reflecting tags merge both. */
  tagsApplied: string[];
};

/**
 * The deferred flat grant, then the verified domain's signup grant (credits, partner org, tags,
 * entitlements). Partner tags are applied after the flat release so callers can merge tagsApplied
 * into the returned tag snapshot.
 */
export async function applyEmailVerifiedGrants(params: {
  user: PendingFreeCreditUser;
  verifiedEmail: string;
  trigger: SeatCeilingRaiseTrigger;
  releaseReason: string;
  logger: Logger;
}): Promise<EmailVerifiedGrantsResult> {
  const { user, verifiedEmail, trigger, releaseReason, logger } = params;
  const release = await releaseVerifiedPendingFreeCredits(user, releaseReason, logger);
  let domainGrant: SignupDomainGrantResult = {
    creditsGranted: 0,
    currentCredits: null,
    joinedOrganizationId: null,
    tagsApplied: [],
    subscriptionCreditsGranted: 0,
    subscriptionGranted: false,
    packageRefusal: null,
  };
  try {
    domainGrant = await applySignupDomainGrant({ userId: user.id, email: verifiedEmail, trigger, logger });
  } catch (error) {
    // Documented never to throw; guarded anyway because a throw here would fail a proven login
    // (as in releaseVerifiedPendingFreeCredits, packages/server-utils/src/auth/pendingFreeCredits.ts).
    logger.error(`Domain signup grant (${trigger}) failed for user ${user.id}`, error);
  }
  await refreshSignupRiskScore(user.id, logger);
  await requestRiskEvidenceRefresh(user.id, 'email_verified', logger);
  return {
    creditsGranted: release.creditsGranted + domainGrant.creditsGranted,
    currentCredits: domainGrant.currentCredits ?? release.currentCredits,
    tags: release.tags,
    joinedOrganizationId: domainGrant.joinedOrganizationId,
    subscriptionCreditsGranted: domainGrant.subscriptionCreditsGranted,
    tagsApplied: domainGrant.tagsApplied,
  };
}
