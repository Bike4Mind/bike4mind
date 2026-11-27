import {
  isSignupGrantBlocked,
  PENDING_FREE_CREDITS_TAG,
  signupGrantRemaining,
  type IUserDocument,
} from '@bike4mind/common';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';
import { isSignupGrantHeldForReview } from './signupRisk';

/**
 * Why an admin action changed nothing. A no-op is an answer, never a silent zero: the caller shows the reason
 * and writes no audit entry.
 */
export type SignupGrantNoopReason =
  | 'no_grant'
  | 'blocked'
  | 'not_blocked'
  | 'already_blocked'
  | 'not_held'
  | 'withheld'
  | 'held_for_review'
  | 'tranche_pending'
  | 'nothing_remaining'
  | 'not_paid';

export type SignupGrantAdminAction = 'release_held' | 'release_remaining' | 'block' | 'unblock';

export type ClassifiableUser = Pick<
  IUserDocument,
  'signupGrant' | 'signupGrantAssessment' | 'signupGrantHeldReason' | 'tags'
> &
  Partial<Pick<IUserDocument, 'emailVerified' | 'isBanned' | 'disputePending' | 'moderation' | 'isModerated'>>;

export type SignupGrantActionClass = { eligible: true } | { eligible: false; reason: SignupGrantNoopReason };

const eligible: SignupGrantActionClass = { eligible: true };
const refuse = (reason: SignupGrantNoopReason): SignupGrantActionClass => ({ eligible: false, reason });

/**
 * The single answer to "can this action apply to this account right now". The mutators gate on it and the bulk
 * dry-run reports it, so a preview can never promise what the real run refuses. It reads the account only: a
 * payout can still come back unpaid for a reason found while paying (a restricted account, an already-paid
 * grant), which is why a pass here is "eligible", not "will pay". Only release_remaining reads `dripCap`.
 */
export function classifySignupGrantAction(
  user: ClassifiableUser | null | undefined,
  action: SignupGrantAdminAction,
  dripCap?: number
): SignupGrantActionClass {
  if (!user) return refuse('no_grant');
  if (action === 'release_held') return classifyReleaseHeld(user);
  const grant = user.signupGrant;
  if (!grant) return refuse('no_grant');
  switch (action) {
    case 'block':
      return isSignupGrantBlocked(user) ? refuse('already_blocked') : eligible;
    case 'unblock':
      return isSignupGrantBlocked(user) ? eligible : refuse('not_blocked');
    case 'release_remaining':
      if (isSignupGrantBlocked(user)) return refuse('blocked');
      if (grant.stage === 'pending_email') return refuse('tranche_pending');
      if (isSignupGrantHeldForReview(user)) return refuse('held_for_review');
      return signupGrantRemaining(grant, dripCap) > 0 ? eligible : refuse('nothing_remaining');
  }
}

/**
 * A tranche held for the pool can belong to an account with no `signupGrant` (the pre-staged free-credit path),
 * which the bulk release already pays, so the held state is read before the grant. Withheld mirrors the gates
 * the release itself applies.
 */
function classifyReleaseHeld(user: ClassifiableUser): SignupGrantActionClass {
  const held = !!user.signupGrantHeldReason && !!user.tags?.includes(PENDING_FREE_CREDITS_TAG);
  if (!held && !user.signupGrant) return refuse('no_grant');
  if (isSignupGrantBlocked(user)) return refuse('blocked');
  if (isSignupGrantHeldForReview(user)) return refuse('held_for_review');
  if (!held) return refuse('not_held');
  if (!user.emailVerified || accountBlockReasons(user).length || isAiAccessRevoked(user)) return refuse('withheld');
  return eligible;
}
