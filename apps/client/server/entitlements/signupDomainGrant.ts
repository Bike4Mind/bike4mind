import '@client/lib/settings/registerContributedSettings';
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
import { grantIndividualAdminSubscription } from '@server/subscriptions/grantIndividualAdminSubscription';
import { runPartnerSignupHooks, type PartnerSignupRuleMatch } from '@server/entitlements/partnerSignupHooks';
import { pushEntitlementInvalidation, pushSubscriptionsInvalidation } from '@server/entitlements/invalidate';
import {
  notifyPartnerSignupBlockedAtCapacity,
  notifySeatCeilingRaised,
  type SeatCeilingRaiseTrigger,
} from '@server/organizations/notifySeatCeilingRaised';
import { premiumPartnerSignupHooks } from '@server/premium-generated/premiumPartnerSignupHooks.generated';

export type SignupDomainGrantResult = {
  /** Domain signup credits added by this call; 0 when none applied or the grant failed. */
  creditsGranted: number;
  /** Balance after the grant; null when nothing was granted. */
  currentCredits: number | null;
  /** The partner org the user was just added to; null when no membership was added. */
  joinedOrganizationId: string | null;
  /** Partner-rule tags merged into the user's tags; empty when none applied or the write failed. */
  tagsApplied: string[];
  /** Plan credits added by the rule's subscription grant in this call; 0 when none. Not part of creditsGranted. */
  subscriptionCreditsGranted: number;
  /** Whether this call granted the rule's subscription; false when none applied, already active, or failed. */
  subscriptionGranted: boolean;
};

const NO_GRANT: SignupDomainGrantResult = {
  creditsGranted: 0,
  currentCredits: null,
  joinedOrganizationId: null,
  tagsApplied: [],
  subscriptionCreditsGranted: 0,
  subscriptionGranted: false,
};

/**
 * Everything a newly proven email's domain confers at signup: the one-time domain signup credits,
 * partner-rule org membership (with the seat-ceiling / at-capacity alerts), partner-rule user tags,
 * the partner-rule individual subscription, and the entitlement cache wake-up. Shared by every path
 * that proves email ownership: the new-account branches of /api/otc/verify,
 * server/utils/auth/verifyCallback.ts and pages/api/auth/okta/callback.ts, and every path that
 * verifies an EXISTING account via server/auth/emailVerifiedGrants.ts.
 *
 * `email` must already be verified. Source precedence (issue #293): a DB PartnerSignupRule wins;
 * the env registry is the fallback for a domain not yet in the collection, and `matched` lets a rule
 * grant access with 0 bonus credits without falling through to the env amount.
 *
 * A matched DB rule then runs the overlay partner signup hooks (./partnerSignupHooks.ts), but only
 * when no core step failed. Signup is a one-time edge, so a skip is logged: only a re-verify (e.g. the
 * admin verify-email route) re-runs this function and reaches the hooks.
 *
 * Never throws: each step logs and swallows its own failure so the caller's already-successful
 * verification or signup is never failed. The credit grant (stable `domain-grant-credits:${userId}`
 * transactionId), the membership write and the tag merge ($addToSet) are all idempotent, so a
 * re-run from another path or a retry cannot double-apply. The subscription grant skips when the
 * user already has any non-terminal individual subscription, and its deterministic row id makes a
 * repeat or concurrent grant a no-op.
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
  // Only a DB rule can confer org membership, tags, a subscription or run partner hooks; the env
  // registry has none of these.
  let partnerRule: PartnerSignupRuleMatch | null;
  let partnerTags: string[];
  let partnerSubscription: PartnerRuleSubscription | null;
  try {
    const partnerGrant = await partnerSignupGrantForEmail(email, true);
    if (partnerGrant.matched) {
      domainGrantKeys = partnerGrant.entitlements;
      signupCredits = partnerGrant.signupCredits;
      partnerRule = {
        id: partnerGrant.ruleId,
        domain: partnerGrant.domain,
        organizationId: partnerGrant.organizationId,
      };
      partnerTags = partnerGrant.tags;
      partnerSubscription = partnerGrant.subscription;
    } else {
      domainGrantKeys = entitlementsForEmail(email, true);
      signupCredits = signupCreditsForKeys(domainGrantKeys);
      partnerTags = [];
      partnerSubscription = null;
      partnerRule = null;
    }
  } catch (resolveError) {
    logger.error(`Signup domain grant could not be resolved for user ${userId} (${trigger})`, resolveError);
    return { ...NO_GRANT, tagsApplied: [] };
  }

  const result: SignupDomainGrantResult = { ...NO_GRANT, tagsApplied: [] };
  let coreStepFailed = false;

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
      coreStepFailed = true;
    }
  }

  if (partnerRule?.organizationId) {
    const membership = await applyPartnerMembership(userId, partnerRule.organizationId, trigger, logger);
    if (membership.ok) {
      result.joinedOrganizationId = membership.joinedOrganizationId;
    } else {
      coreStepFailed = true;
    }
  }

  if (partnerTags.length > 0 && (await applyPartnerTags(userId, partnerTags, trigger, logger))) {
    result.tagsApplied = partnerTags;
  }

  if (partnerRule && partnerSubscription) {
    const granted = await applyPartnerSubscription(userId, partnerRule, partnerSubscription, trigger, logger);
    if (granted) {
      result.subscriptionGranted = true;
      result.subscriptionCreditsGranted = granted.credits;
      result.currentCredits = granted.currentCredits ?? result.currentCredits;
      await pushSubscriptionsInvalidation(userId, logger);
    }
  }

  // Before the invalidation push, so the wake-up also covers whatever state a hook wrote.
  if (partnerRule && coreStepFailed) {
    logger.warn(
      `Partner signup hooks skipped for user ${userId} (rule ${partnerRule.id}, ${trigger}): a core grant step failed`
    );
  } else if (partnerRule) {
    await runPartnerSignupHooks(premiumPartnerSignupHooks, {
      userId,
      rule: partnerRule,
      joinedOrganizationId: result.joinedOrganizationId,
      trigger,
      logger,
    });
  }

  // A tag can itself be an entitlement key (getUserEntitlements reads user.tags) and a subscription's
  // price can map to entitlement keys, so both wake the cache too.
  if (domainGrantKeys.size > 0 || result.tagsApplied.length > 0 || result.subscriptionGranted) {
    await pushEntitlementInvalidation(userId, logger);
  }

  return result;
}

type PartnerMembershipOutcome = { ok: true; joinedOrganizationId: string | null } | { ok: false };

type PartnerRuleSubscription = { priceId: string; durationMonths: number };

/**
 * Grants a partner rule's individual subscription through the admin-grant path. Skips when the user
 * already has any non-terminal individual subscription (never stacks a plan on a Stripe subscriber), which
 * also makes a re-run from the signup and email-verify paths a no-op. Returns the credits and
 * post-grant balance when newly granted, null otherwise.
 */
async function applyPartnerSubscription(
  userId: string,
  { id: ruleId, domain }: PartnerSignupRuleMatch,
  subscription: PartnerRuleSubscription,
  trigger: SeatCeilingRaiseTrigger,
  logger: Logger
): Promise<{ credits: number; currentCredits: number | null } | null> {
  const { priceId, durationMonths } = subscription;
  try {
    const grant = await grantIndividualAdminSubscription({
      userId,
      priceId,
      durationMonths,
      grantedBy: `partner-rule:${ruleId}`,
      grantedReason: `partner signup rule ${domain}`,
      skipIfAnyActiveIndividual: true,
      // One grant per rule per user, ever: a re-verify after the plan lapses must not re-grant it.
      subscriptionId: `partner_grant_${ruleId}_${userId}`,
    });
    if (grant.status === 'granted') {
      logger.info(
        `Partner-rule subscription: granted ${priceId} for ${durationMonths} month(s) to user ${userId} (${trigger})`
      );
      return { credits: grant.credits, currentCredits: grant.currentCredits };
    }
    if (grant.status === 'already_active') {
      logger.info(
        `Partner-rule subscription: user ${userId} already has an active individual subscription (${trigger}); skipped`
      );
    } else if (grant.status === 'already_granted') {
      logger.info(`Partner-rule subscription: rule subscription already granted to user ${userId} (${trigger})`);
    } else {
      logger.warn(
        `Partner-rule subscription not granted to user ${userId} (rule ${ruleId}): unknown plan ${priceId}; ` +
          `the plan was likely removed after the rule was saved`
      );
    }
  } catch (subscriptionError) {
    logger.error(
      `Partner-rule subscription grant failed for user ${userId} (rule ${ruleId}, ${trigger}); not retried ` +
        `automatically - grant ${priceId} for ${durationMonths} month(s) by hand via admin grant-subscription`,
      subscriptionError
    );
  }
  return null;
}

/** Merges a partner rule's tags into the user's tags. Returns whether the write succeeded. */
async function applyPartnerTags(
  userId: string,
  tags: string[],
  trigger: SeatCeilingRaiseTrigger,
  logger: Logger
): Promise<boolean> {
  try {
    await userRepository.addTagsToUser(userId, tags);
    logger.info(`Partner-rule tags: applied [${tags.join(', ')}] to user ${userId} (${trigger})`);
    return true;
  } catch (tagError) {
    logger.error(
      `Partner-rule tag stamp failed for user ${userId} (${trigger}); not retried automatically - ` +
        `re-adding [${tags.join(', ')}] by hand is safe ($addToSet)`,
      tagError
    );
    return false;
  }
}

/**
 * Derive-on-write org membership for a partner rule. applyPartnerRuleMembership re-reads the
 * verified user, is idempotent, and never removes anyone. `joinedOrganizationId` is the org id when
 * the user was added; at-capacity and org-missing are handled outcomes, only a thrown write is not ok.
 */
async function applyPartnerMembership(
  userId: string,
  organizationId: string,
  trigger: SeatCeilingRaiseTrigger,
  logger: Logger
): Promise<PartnerMembershipOutcome> {
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
      return { ok: true, joinedOrganizationId: organizationId };
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
    return { ok: false };
  }
  return { ok: true, joinedOrganizationId: null };
}
