import { CreditHolderType } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { creditService, organizationService } from '@bike4mind/services';
import { entitlementsForEmail, signupCreditsForKeys } from '@client/lib/entitlements/registry';
import { partnerSignupGrantForEmail } from '@server/entitlements/partnerRules';
import { pushEntitlementInvalidation } from '@server/entitlements/invalidate';
import {
  notifyPartnerSignupBlockedAtCapacity,
  notifySeatCeilingRaised,
  type SeatCeilingRaiseTrigger,
} from '@server/organizations/notifySeatCeilingRaised';

export type SignupDomainGrantResult = {
  /** Domain signup credits added by this call; 0 when none applied or the grant failed. */
  creditsGranted: number;
  /** Balance after the grant; null when nothing was granted. */
  currentCredits: number | null;
  /** The partner org the user was just added to; null when no membership was added. */
  joinedOrganizationId: string | null;
};

const NO_GRANT: SignupDomainGrantResult = { creditsGranted: 0, currentCredits: null, joinedOrganizationId: null };

/**
 * Everything a newly proven email's domain confers at signup: the one-time domain signup credits,
 * partner-rule org membership (with the seat-ceiling / at-capacity alerts), and the entitlement
 * cache wake-up. Shared by every path that proves email ownership: /api/email/verify,
 * /api/otc/verify (registration and an existing account's first verified login), and the OAuth
 * create and verifying-link branches in server/utils/auth/verifyCallback.ts and
 * pages/api/auth/okta/callback.ts (via server/utils/auth/oauthSignupGrants.ts).
 *
 * `email` must already be verified. Source precedence (issue #293): a DB PartnerSignupRule wins;
 * the env registry is the fallback for a domain not yet in the collection, and `matched` lets a rule
 * grant access with 0 bonus credits without falling through to the env amount.
 *
 * Never throws: each step logs and swallows its own failure so the caller's already-successful
 * verification or signup is never failed. Both the credit grant (stable
 * `domain-grant-credits:${userId}` transactionId) and the membership write are idempotent, so a
 * re-run from another path or a retry cannot double-apply.
 */
export async function applySignupDomainGrant(params: {
  userId: string;
  email: string;
  trigger: SeatCeilingRaiseTrigger;
  logger: Logger;
}): Promise<SignupDomainGrantResult> {
  const { userId, email, trigger, logger } = params;

  let domainGrantKeys: Set<string>;
  let signupCredits: number;
  // Only a DB rule can confer org membership; the env registry has no org concept.
  let partnerOrganizationId: string | null;
  try {
    const partnerGrant = await partnerSignupGrantForEmail(email, true);
    if (partnerGrant.matched) {
      domainGrantKeys = partnerGrant.entitlements;
      signupCredits = partnerGrant.signupCredits;
      partnerOrganizationId = partnerGrant.organizationId;
    } else {
      domainGrantKeys = entitlementsForEmail(email, true);
      signupCredits = signupCreditsForKeys(domainGrantKeys);
      partnerOrganizationId = null;
    }
  } catch (resolveError) {
    logger.error(`Signup domain grant could not be resolved for user ${userId} (${trigger})`, resolveError);
    return NO_GRANT;
  }

  const result: SignupDomainGrantResult = { ...NO_GRANT };

  if (signupCredits > 0) {
    try {
      const holder = await creditService.addCredits(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: signupCredits,
          type: 'generic_add',
          transactionId: `domain-grant-credits:${userId}`,
          reason: 'domain-grant signup credits',
        },
        {
          db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
          creditHolderMethods: userRepository,
        }
      );
      result.creditsGranted = signupCredits;
      result.currentCredits = holder?.currentCredits ?? null;
      logger.info(`Granted ${signupCredits} one-time domain-grant signup credits to user ${userId} (${trigger})`);
    } catch (grantError) {
      logger.error(
        `Domain-grant signup-credit grant failed for user ${userId} (${trigger}); ` +
          `idempotent transactionId domain-grant-credits:${userId} makes a retry safe`,
        grantError
      );
    }
  }

  if (partnerOrganizationId) {
    result.joinedOrganizationId = await applyPartnerMembership(userId, partnerOrganizationId, trigger, logger);
  }

  if (domainGrantKeys.size > 0) {
    await pushEntitlementInvalidation(userId, logger);
  }

  return result;
}

/**
 * Derive-on-write org membership for a partner rule. applyPartnerRuleMembership re-reads the
 * verified user, is idempotent, and never removes anyone. Returns the org id when the user was added.
 */
async function applyPartnerMembership(
  userId: string,
  organizationId: string,
  trigger: SeatCeilingRaiseTrigger,
  logger: Logger
): Promise<string | null> {
  try {
    const membership = await organizationService.applyPartnerRuleMembership(
      { userId, organizationId },
      {
        db: { users: userRepository, organizations: organizationRepository, adminSettings: adminSettingsRepository },
        logger,
      }
    );
    if (membership.added) {
      logger.info(`Partner-rule org membership: added user ${userId} to org ${organizationId} (${trigger})`);
      if (membership.reason === 'added-seat-raised') {
        // The join and raise already committed; the alert/audit is best-effort and never throws.
        await notifySeatCeilingRaised(
          {
            organizationId,
            userId,
            previousSeats: membership.previousSeats,
            newSeats: membership.newSeats,
            trigger,
          },
          logger
        );
      }
      return organizationId;
    }
    if (membership.reason === 'at-capacity') {
      // No auto-raise: a Stripe-billed org (ceiling not raised out of band) or a non-Stripe org
      // already at MAX_SEATS (#1424). Alert an admin to add seats and admit this stranded user.
      await notifyPartnerSignupBlockedAtCapacity({ organizationId, userId, seats: membership.seats, trigger }, logger);
    } else if (membership.reason === 'org-missing') {
      // Surfaces a misconfiguration (dangling org ref) without failing the signup.
      logger.warn(`Partner-rule org membership not applied for user ${userId} (org ${organizationId}): org-missing`);
    }
  } catch (membershipError) {
    logger.error(
      `Partner-rule org auto-add failed for user ${userId} (org ${organizationId}, ${trigger}); ` +
        `membership is idempotent so a retry is safe`,
      membershipError
    );
  }
  return null;
}
