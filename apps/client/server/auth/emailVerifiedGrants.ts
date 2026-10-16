import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { applySignupDomainGrant, type SignupDomainGrantResult } from '@server/entitlements/signupDomainGrant';
import type { SeatCeilingRaiseTrigger } from '@server/organizations/notifySeatCeilingRaised';

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

export type PendingFreeCreditUser = { id: string; tags?: readonly string[] | null; pendingCreditGrant?: number | null };

export type PendingFreeCreditReleaseResult = {
  creditsGranted: number;
  /** Balance after the grant; null when nothing was granted. */
  currentCredits: number | null;
  /** The persisted tags with PENDING_FREE_CREDITS_TAG removed; null when the tag was not removed. */
  tags: string[] | null;
};

const NOTHING_RELEASED: PendingFreeCreditReleaseResult = { creditsGranted: 0, currentCredits: null, tags: null };

export type EmailVerifiedGrantsResult = PendingFreeCreditReleaseResult & {
  /** The partner org the user was just added to; null when no membership was added. */
  joinedOrganizationId: string | null;
  /** Partner-rule tags merged into the user AFTER `tags` was persisted; callers reflecting tags merge both. */
  tagsApplied: string[];
};

/**
 * The disposable-email gate registerUser applies before any free credits. A settings read failure
 * withholds the grant.
 */
export async function isEligibleForFreeCredits(email: string, logger: Logger): Promise<boolean> {
  try {
    return !(await userService.shouldBlockDisposableEmail(email, { adminSettings: adminSettingsRepository }));
  } catch (error) {
    logger.error('Free-credit eligibility check failed; withholding the grant', error);
    return false;
  }
}

/**
 * Release a PENDING_FREE_CREDITS_TAG grant and persist the tag removal. No-op for an untagged user.
 * On failure the tag stays for the backfillPendingFreeCredits script.
 */
export async function releaseVerifiedPendingFreeCredits(
  user: PendingFreeCreditUser,
  reason: string,
  logger: Logger
): Promise<PendingFreeCreditReleaseResult> {
  let release: Awaited<ReturnType<typeof userService.releasePendingFreeCredits>>;
  try {
    release = await userService.releasePendingFreeCredits(
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
  } catch (error) {
    // Documented never to throw; guarded anyway because a throw here would fail a proven login.
    logger.error(`Pending free-credit release failed for user ${user.id}`, error);
    return NOTHING_RELEASED;
  }
  if (!release.released) return NOTHING_RELEASED;

  const granted = { creditsGranted: release.creditsGranted, currentCredits: release.currentCredits };
  try {
    await userRepository.update({ id: user.id, ...release.patch });
  } catch (error) {
    // The credits landed under an idempotent transactionId, so the backfill script can safely
    // re-run the release to clear the tag.
    logger.error(`Released pending free credits for user ${user.id} but the tag removal failed`, error);
    return { ...granted, tags: null };
  }
  logger.info(`Released ${release.creditsGranted} pending free credits to user ${user.id} (${reason})`);
  return { ...granted, tags: release.patch.tags ?? null };
}

/**
 * The deferred flat grant, then the verified domain's signup grant (credits, partner org, tags,
 * entitlements). Order matters: the release $sets the whole tags array from the caller's snapshot,
 * so the partner-tag $addToSet must run after it or the release would erase those tags.
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
  };
  try {
    domainGrant = await applySignupDomainGrant({ userId: user.id, email: verifiedEmail, trigger, logger });
  } catch (error) {
    // Documented never to throw; guarded for the same reason as the release above.
    logger.error(`Domain signup grant (${trigger}) failed for user ${user.id}`, error);
  }
  return {
    creditsGranted: release.creditsGranted + domainGrant.creditsGranted,
    currentCredits: domainGrant.currentCredits ?? release.currentCredits,
    tags: release.tags,
    joinedOrganizationId: domainGrant.joinedOrganizationId,
    tagsApplied: domainGrant.tagsApplied,
  };
}
