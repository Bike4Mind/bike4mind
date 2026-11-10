import { type IUser, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { isEligibleForFreeCredits, releaseVerifiedPendingFreeCredits } from '@server/auth/emailVerifiedGrants';

const PAGE_SIZE = 100;

// Includes accounts created after the hold as well as the original cohort.
const pendingSignupsQuery = (domain: string) => ({
  emailVerified: true,
  tags: PENDING_FREE_CREDITS_TAG,
  email: { $regex: `@(?:[^@]+\\.)?${escapeRegex(domain)}\\.*$`, $options: 'i' },
});

/**
 * Ids of up to `limit` verified accounts on the domain whose free credits are still held. Read live: a
 * hold's own cohort and signupCount are fixed when the hold is created, while later signups keep joining it.
 */
export async function listHeldSignupIds(domain: string, limit: number): Promise<string[]> {
  const users = await User.find(pendingSignupsQuery(domain), { _id: 1 }).sort({ _id: 1 }).limit(limit).lean();
  return users.map(user => String(user._id));
}

export type HeldSignupCreditRelease = { creditsReleased: number; remaining: number; nextCursor: string | null };

/**
 * Pays out the held free credits of one page of verified accounts on a released hold's domain. Shared by
 * the admin Release (apps/client/pages/api/admin/signup-domain-holds.ts) and the advisory auto-release
 * (signupDomainHoldAssessment.ts), so both pay out the same accounts the same way. Never re-tags
 * already credited users: only the existing pending breadcrumb is eligible for recovery.
 */
export async function releaseHeldSignupCredits(
  domain: string,
  options: {
    afterUserId?: string;
    reason: string;
    bypassBudget: boolean;
    logger: Logger;
    /** Pays only these accounts, in one call (still subject to the pending query); the rest stays pending. */
    onlyUserIds?: string[];
    /** Accounts this caller may not pay out; they stay pending and count toward `remaining`. */
    skipUser?: (user: IUser & { _id: unknown }) => boolean;
  }
): Promise<HeldSignupCreditRelease> {
  const pendingQuery = pendingSignupsQuery(domain);
  const { onlyUserIds } = options;
  if (onlyUserIds?.length === 0) return { creditsReleased: 0, remaining: 0, nextCursor: null };
  const pageSize = onlyUserIds?.length ?? PAGE_SIZE;
  const idFilter = onlyUserIds ? { $in: onlyUserIds } : options.afterUserId ? { $gt: options.afterUserId } : undefined;
  const users = await User.find({ ...pendingQuery, ...(idFilter ? { _id: idFilter } : {}) })
    .sort({ _id: 1 })
    .limit(pageSize);
  const nextCursor = !onlyUserIds && users.length === pageSize ? String(users[users.length - 1]._id) : null;
  let creditsReleased = 0;
  let stillPending = 0;
  for (const user of users) {
    if (options.skipUser?.(user)) {
      stillPending++;
      continue;
    }
    // Releasing a hold never overrides the disposable/blocked-domain gate; those users stay pending.
    if (!user.email || !(await isEligibleForFreeCredits(user.email, options.logger))) {
      stillPending++;
      continue;
    }
    const result = await releaseVerifiedPendingFreeCredits(
      { id: String(user._id), tags: user.tags, pendingCreditGrant: user.pendingCreditGrant },
      options.reason,
      options.logger,
      undefined,
      { bypassBudget: options.bypassBudget }
    );
    creditsReleased += result.creditsGranted;
    if (!result.tags) stillPending++;
  }
  // The regex cannot use an index, so recount only when this call did not see every candidate.
  const remaining =
    !onlyUserIds && (options.afterUserId || nextCursor) ? await User.countDocuments(pendingQuery) : stillPending;
  return { creditsReleased, remaining, nextCursor };
}
