import type { ISignupRiskScore, UserModerationStatus } from '@bike4mind/common';

/** The conditions that make an account unusable. The order below is precedence. */
export type AccountBlockReason = 'banned' | 'disputePending' | 'suspended';

/**
 * The account-state fields the predicates read. A structural subset of `IUser` (loose optional
 * fields) so a full `IUserDocument`, a webhook's partial read, or a built `next` snapshot all fit.
 */
export interface AccountStateFields {
  isBanned?: boolean | null;
  disputePending?: boolean | null;
  moderation?: { status?: UserModerationStatus | null } | null;
}

/**
 * The single source of truth for "this account is blocked".
 *
 * `suspend_pending` and `throttled` are deliberately NOT reasons: the former awaits a human's
 * confirmation and the latter is a rate limit, so neither is refused at key-use time. Both the
 * admin update and the Stripe dispute webhook derive their deactivation decision from this list,
 * and the use-time gate in `apps/client/server/cli/auth.ts` must switch on it in the same order.
 */
export function accountBlockReasons(user: AccountStateFields): AccountBlockReason[] {
  const reasons: AccountBlockReason[] = [];
  if (user.isBanned) reasons.push('banned');
  if (user.disputePending) reasons.push('disputePending');
  if (user.moderation?.status === 'suspended') reasons.push('suspended');
  return reasons;
}

/**
 * True when `next` has any block reason `previous` lacks. Per-reason (not "was clear, now
 * blocked"): an already-banned user who is then disputed or suspended enters a new reason, and
 * their keys are deactivated again so anything minted in between is revoked.
 */
export function entersBlockedState(previous: AccountStateFields, next: AccountStateFields): boolean {
  const before = accountBlockReasons(previous);
  return accountBlockReasons(next).some(reason => !before.includes(reason));
}

export const AI_ACCESS_REVOKED_MESSAGE =
  'AI features are disabled on your account by an administrator. Please contact support.';

export const AI_ACCESS_PENDING_REVIEW_MESSAGE =
  'AI features are temporarily unavailable while your account awaits review. You can still sign in and access your data. Please contact support to request a review.';

export type AiAccessStateFields = {
  isModerated?: boolean | null;
  riskScore?: Pick<ISignupRiskScore, 'reviewState'> | null;
};

/** Review holds are separate from manual restrictions, so approval cannot undo an admin restriction. */
export function aiAccessDeniedMessage(user: AiAccessStateFields): string | null {
  if (isAiAccessRevoked(user)) return AI_ACCESS_REVOKED_MESSAGE;
  if (user.riskScore?.reviewState === 'pending') return AI_ACCESS_PENDING_REVIEW_MESSAGE;
  return null;
}

/**
 * True when the admin "Moderate" action has revoked the user's AI access. Unlike
 * `accountBlockReasons`, this does not block sign-in or data access - only AI features. It is
 * independent of `moderation.status`: escalation never writes `isModerated` (see `setModerationStatus`).
 */
export function isAiAccessRevoked(user: { isModerated?: boolean | null }): boolean {
  return user.isModerated === true;
}
