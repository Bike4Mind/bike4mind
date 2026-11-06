import {
  isSignupGrantBlocked,
  PENDING_FREE_CREDITS_TAG,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  signupGrantRemaining,
  type AdminSignupGrantActionState,
  type AdminSignupGrantPending,
  type IUserDocument,
} from '@bike4mind/common';
import { userService } from '@bike4mind/services';

type RewardTotals = Record<'held' | 'paused', { count: number; credits: number }>;

export type SignupGrantPendingInput = {
  user: userService.ClassifiableUser &
    Partial<Pick<IUserDocument, 'grantPackageId' | 'pendingCreditGrant' | 'signupGrantHeldAt'>>;
  schedule: { dripCap: number; dailyCredits: number };
  rewards: RewardTotals;
  /** Release-remaining is the one budget-exempt payout, so it stays with full admins. */
  viewerIsAdmin: boolean;
};

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const actionState = (verdict: userService.SignupGrantActionClass, permitted: boolean): AdminSignupGrantActionState =>
  verdict.eligible
    ? { available: true, reason: null, permitted }
    : { available: false, reason: verdict.reason, permitted };

/**
 * Everything the profile pending panel shows, read from the account and the live schedule only. Each action's
 * state comes from the same classifier the mutators and the bulk dry-run gate on, so the panel never offers
 * what the real run would refuse.
 */
export function buildSignupGrantPending({
  user,
  schedule,
  rewards,
  viewerIsAdmin,
}: SignupGrantPendingInput): AdminSignupGrantPending {
  const grant = user.signupGrant ?? null;
  const classify = (action: userService.SignupGrantAdminAction) =>
    userService.classifySignupGrantAction(user, action, schedule.dripCap);
  const heldTranche = !!user.signupGrantHeldReason && !!user.tags?.includes(PENDING_FREE_CREDITS_TAG);

  return {
    hasGrant: !!grant,
    source: grant ? (user.grantPackageId ? 'package' : 'default') : null,
    stage: grant?.stage ?? null,
    schedule: grant
      ? {
          signupCredits: grant.signupCredits,
          unlockCredits: grant.unlockCredits,
          received: grant.creditsReleased,
          dripped: grant.dripCredits ?? 0,
          dripCap: schedule.dripCap,
          dailyCredits: schedule.dailyCredits,
          remaining: signupGrantRemaining(grant, schedule.dripCap),
          dripRemaining: signupGrantDripOpen(grant) ? signupGrantDripRemaining(grant, schedule.dripCap) : 0,
        }
      : null,
    held: heldTranche
      ? {
          reason: user.signupGrantHeldReason ?? null,
          since: iso(user.signupGrantHeldAt),
          credits: user.pendingCreditGrant ?? 0,
        }
      : null,
    heldUnlock: grant?.heldUnlock
      ? { reason: grant.heldUnlock.reason, releaseAt: iso(grant.heldUnlock.releaseAt) ?? '' }
      : null,
    forfeited: grant?.unlockForfeited
      ? { cause: grant.unlockForfeited.cause, at: iso(grant.unlockForfeited.at) ?? '' }
      : null,
    blocked: isSignupGrantBlocked(user) ? { at: iso(grant?.blocked?.at) ?? '' } : null,
    rewards: {
      queuedCount: rewards.held.count,
      queuedCredits: rewards.held.credits,
      pausedCount: rewards.paused.count,
      pausedCredits: rewards.paused.credits,
    },
    lastActivityCreditDay: grant?.lastDripDay ?? null,
    actions: {
      releaseHeld: actionState(classify('release_held'), true),
      releaseRemaining: actionState(classify('release_remaining'), viewerIsAdmin),
      block: actionState(classify('block'), true),
      unblock: actionState(classify('unblock'), true),
    },
  };
}
