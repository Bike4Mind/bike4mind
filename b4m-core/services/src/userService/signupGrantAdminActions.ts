import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import type { HeldCreditRewardRepository } from '../creditService/payCreditReward';
import type { FreeCreditAdapters } from './freeCredits';
import { releaseHeldGrantNow, type HeldGrantAdapters } from './heldSignupGrants';
import { classifySignupGrantAction, type SignupGrantNoopReason } from './signupGrantActionClassifier';
import { resolveDripLimits, unlockSignupGrant } from './stagedSignupGrant';

export type SignupGrantActionResult =
  { outcome: 'applied'; credits: number } | { outcome: 'noop'; reason: SignupGrantNoopReason };

const noop = (reason: SignupGrantNoopReason): SignupGrantActionResult => ({ outcome: 'noop', reason });

/**
 * Pays the user's held signup tranche now, outside the daily pools. Only a tranche held for the pool is
 * released here; one held for risk review is decided from the review queue.
 */
export async function releaseHeldSignupGrant(
  userId: string,
  adapters: HeldGrantAdapters
): Promise<SignupGrantActionResult> {
  const verdict = classifySignupGrantAction(await adapters.grant.db.users.findById(userId), 'release_held');
  if (!verdict.eligible) return noop(verdict.reason);
  const entry = await releaseHeldGrantNow(userId, adapters);
  // A failed payout is logged by the release; surfacing it as an error keeps it out of the audit log.
  if (entry.outcome === 'failed') throw new Error('Held signup grant release failed');
  return entry.outcome === 'released' && entry.credits > 0
    ? { outcome: 'applied', credits: entry.credits }
    : noop('not_paid');
}

/**
 * Pays the rest of the cap now, outside the pools, through the admin unlock. A grant whose first tranche is
 * still pending (waiting on verification, the review queue or a pool hold) is not released here: the tranche
 * is paid first, and an account held for review is decided from the review queue.
 */
export async function releaseRemainingSignupGrant(
  userId: string,
  adapters: Parameters<typeof unlockSignupGrant>[2]
): Promise<SignupGrantActionResult> {
  const user = await adapters.db.users.findById(userId);
  const { dripCap } = await resolveDripLimits(adapters.db.adminSettings);
  const verdict = classifySignupGrantAction(user, 'release_remaining', dripCap);
  if (!verdict.eligible) return noop(verdict.reason);
  const { creditsGranted } = await unlockSignupGrant(userId, 'admin', adapters);
  return creditsGranted > 0 ? { outcome: 'applied', credits: creditsGranted } : noop('not_paid');
}

export type SignupGrantBlockAdapters = {
  users: FreeCreditAdapters['db']['users'];
  heldRewards: Pick<HeldCreditRewardRepository, 'pauseForUser' | 'resumeForUser'>;
  now?: () => Date;
  /** Runs in the same transaction as the flag write, so a failed audit entry rolls the change back. */
  audit?: () => Promise<void>;
};

export type SignupGrantBlockResult = SignupGrantActionResult & { rewardsAffected: number };

/** Stops future grants and pauses queued rewards atomically with the block and its audit entry. */
export async function blockSignupGrant(
  userId: string,
  adapters: SignupGrantBlockAdapters
): Promise<SignupGrantBlockResult> {
  const { users, heldRewards } = adapters;
  return withTransaction<SignupGrantBlockResult>(async () => {
    const user = await users.findById(userId);
    if (!user?.signupGrant) return { ...noop('no_grant'), rewardsAffected: 0 };
    const verdict = classifySignupGrantAction(user, 'block');
    if (verdict.eligible) {
      const updated = await users.update({
        id: userId,
        signupGrant: { ...user.signupGrant, blocked: { at: adapters.now?.() ?? new Date() } },
      });
      if (!updated) throw new Error('Signup grant block update failed');
      await adapters.audit?.();
    }
    // Re-pausing also repairs rewards stranded by an older non-atomic block.
    const rewardsAffected = await heldRewards.pauseForUser(userId);
    return verdict.eligible
      ? { outcome: 'applied', credits: 0, rewardsAffected }
      : { ...noop(verdict.reason), rewardsAffected };
  });
}

/**
 * Resumes grants and paused rewards atomically. A tranche verified during the block is queued for the
 * signup pool, since verification already passed and nothing else would trigger it.
 */
export async function unblockSignupGrant(
  userId: string,
  adapters: SignupGrantBlockAdapters
): Promise<SignupGrantBlockResult> {
  const { users, heldRewards } = adapters;
  return withTransaction<SignupGrantBlockResult>(async () => {
    const user = await users.findById(userId);
    if (!user?.signupGrant) return { ...noop('no_grant'), rewardsAffected: 0 };
    const verdict = classifySignupGrantAction(user, 'unblock');
    if (verdict.eligible) {
      const { blocked: _lifted, ...grant } = user.signupGrant;
      const requeue = grant.stage === 'pending_email' && !!user.emailVerified && !user.signupGrantHeldReason;
      const updated = await users.update({
        id: userId,
        signupGrant: grant,
        ...(requeue
          ? { signupGrantHeldReason: 'budget_exhausted' as const, signupGrantHeldAt: adapters.now?.() ?? new Date() }
          : {}),
      });
      if (!updated) throw new Error('Signup grant unblock update failed');
      if (requeue) await users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
      await adapters.audit?.();
    }
    // Re-resuming also repairs rewards stranded by an older non-atomic unblock.
    const rewardsAffected = await heldRewards.resumeForUser(userId);
    return verdict.eligible
      ? { outcome: 'applied', credits: 0, rewardsAffected }
      : { ...noop(verdict.reason), rewardsAffected };
  });
}
