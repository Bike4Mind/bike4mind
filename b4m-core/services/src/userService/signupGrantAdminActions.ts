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

/**
 * Stops every future grant and reward for the account; nothing already granted is taken back. The flag and
 * the user's queued rewards are separate writes, so a repeat on an already-blocked account re-pauses the
 * rewards instead of stopping early, which heals a block that failed between the two.
 */
export async function blockSignupGrant(
  userId: string,
  adapters: SignupGrantBlockAdapters
): Promise<SignupGrantBlockResult> {
  const { users, heldRewards } = adapters;
  // The staged-grant and reward payouts re-read the flag inside their own transaction, so one racing this
  // block conflicts and sees it; the other reward paths check it once before paying and are best-effort.
  const state = await withTransaction<'blocked' | 'already_blocked' | 'no_grant'>(async () => {
    const user = await users.findById(userId);
    if (!user?.signupGrant) return 'no_grant';
    if (!classifySignupGrantAction(user, 'block').eligible) return 'already_blocked';
    const updated = await users.update({
      id: userId,
      signupGrant: { ...user.signupGrant, blocked: { at: adapters.now?.() ?? new Date() } },
    });
    if (!updated) throw new Error('Signup grant block update failed');
    await adapters.audit?.();
    return 'blocked';
  });
  if (state === 'no_grant') return { ...noop('no_grant'), rewardsAffected: 0 };
  const rewardsAffected = await heldRewards.pauseForUser(userId);
  return state === 'blocked'
    ? { outcome: 'applied', credits: 0, rewardsAffected }
    : { ...noop('already_blocked'), rewardsAffected };
}

/**
 * Resumes the schedule where it stopped and puts the user's paused rewards back in the queue at their place.
 * A tranche whose email was verified during the block is queued for the signup pool so the held-release job
 * pays it; verification already passed, so nothing else would trigger it.
 */
export async function unblockSignupGrant(
  userId: string,
  adapters: SignupGrantBlockAdapters
): Promise<SignupGrantBlockResult> {
  const { users, heldRewards } = adapters;
  const state = await withTransaction<'unblocked' | 'not_blocked' | 'no_grant'>(async () => {
    const user = await users.findById(userId);
    if (!user?.signupGrant) return 'no_grant';
    if (!classifySignupGrantAction(user, 'unblock').eligible) return 'not_blocked';
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
    return 'unblocked';
  });
  if (state === 'no_grant') return { ...noop('no_grant'), rewardsAffected: 0 };
  // Also on 'not_blocked': a retry after a failure between the flag and the rewards finishes the job.
  const rewardsAffected = await heldRewards.resumeForUser(userId);
  return state === 'unblocked'
    ? { outcome: 'applied', credits: 0, rewardsAffected }
    : { ...noop('not_blocked'), rewardsAffected };
}
