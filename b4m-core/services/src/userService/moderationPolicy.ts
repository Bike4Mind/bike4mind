import type { IModerationHit, IUserRepository, UserModerationStatus } from '@bike4mind/common';

/**
 * Per-user moderation-hit policy.
 *
 * Repeated moderation hits by a single user escalate automatically so offenders are
 * caught before the LLM provider takes account-level action:
 *   - {@link MODERATION_POLICY.throttleAt} hits within the rolling window -> auto-`throttled`
 *     (a tighter rate limit is enforced downstream until `throttledUntil`).
 *   - {@link MODERATION_POLICY.suspendAt} hits within the window -> `suspend_pending`
 *     (flagged for a human to confirm the suspension; NOT auto-blocking, to avoid
 *     false-positive lockouts).
 *
 * Thresholds are intentionally simple constants - product-tunable, but a data model /
 * admin-settings knob is deliberately out of scope for the launch-gate P0.
 */
export const MODERATION_POLICY = {
  /** Hits within the window that trigger auto-throttle. */
  throttleAt: 3,
  /** Hits within the window that flag the account for human-confirmed suspension. */
  suspendAt: 5,
  /** Rolling window over which hits are counted. */
  windowMs: 24 * 60 * 60 * 1000,
  /** How long an auto-throttle lasts once applied. */
  throttleDurationMs: 24 * 60 * 60 * 1000,
  /** While throttled, the max number of generations allowed per {@link MODERATION_POLICY.throttleRateWindowMs}. */
  throttleRateLimit: 5,
  /** The fixed window over which the throttled rate limit is counted. */
  throttleRateWindowMs: 60 * 60 * 1000,
} as const;

/** Cache key for a throttled user's tightened rate-limit counter. */
export function moderationThrottleKey(userId: string): string {
  return `moderation-throttle:${userId}`;
}

/** The escalation action the policy decides for a given number of in-window hits. */
export type ModerationAction = 'none' | 'throttle' | 'suspend_pending';

/**
 * Count moderation hits that fall within the rolling window ending at `now`.
 * Pure - safe to unit test in isolation.
 */
export function countHitsWithinWindow(
  hits: Pick<IModerationHit, 'at'>[] | undefined,
  now: Date,
  windowMs: number = MODERATION_POLICY.windowMs
): number {
  if (!hits?.length) return 0;
  const cutoff = now.getTime() - windowMs;
  return hits.reduce((count, hit) => (new Date(hit.at).getTime() >= cutoff ? count + 1 : count), 0);
}

/**
 * Decide the escalation action from the number of hits within the window.
 * Pure - the single source of truth for the threshold policy.
 */
export function evaluateModerationPolicy(hitsInWindow: number): ModerationAction {
  if (hitsInWindow >= MODERATION_POLICY.suspendAt) return 'suspend_pending';
  if (hitsInWindow >= MODERATION_POLICY.throttleAt) return 'throttle';
  return 'none';
}

export interface ApplyModerationHitResult {
  /** Hits counted within the rolling window (including the one just recorded). */
  hitsInWindow: number;
  /** The action the policy decided for this hit. */
  action: ModerationAction;
  /** The user's escalation status after applying the hit. */
  status: UserModerationStatus;
}

/**
 * Record a moderation hit against a user and escalate their status per {@link MODERATION_POLICY}.
 *
 * Never downgrades an already-`suspended`/`suspend_pending` user back to `throttled` - escalation
 * is monotonic within a window; only a human (admin) or window expiry clears a suspension flag.
 */
export async function applyModerationHit(deps: {
  users: Pick<IUserRepository, 'recordModerationHit' | 'setModerationStatus'>;
  userId: string;
  hit: IModerationHit;
  now?: Date;
}): Promise<ApplyModerationHitResult> {
  const { users, userId, hit } = deps;
  const now = deps.now ?? new Date();

  const updated = await users.recordModerationHit(userId, hit);
  const moderation = updated?.moderation;
  const currentStatus: UserModerationStatus = moderation?.status ?? 'active';

  const hitsInWindow = countHitsWithinWindow(moderation?.hits, now);
  const action = evaluateModerationPolicy(hitsInWindow);

  // Whether the existing throttle is still in force (vs. expired but never cleared).
  const throttleActive =
    currentStatus === 'throttled' &&
    !!moderation?.throttledUntil &&
    new Date(moderation.throttledUntil).getTime() > now.getTime();

  // Decide the escalation transition. Rules:
  //  - suspend_pending escalation wins unless the user is already pending/suspended.
  //  - throttle applies to fresh (`active`) offenders AND re-arms a throttle whose window
  //    has already expired (repeat offense in a new window).
  //  - never downgrade a `suspend_pending`/`suspended` account from the automated path.
  let transitionTo: UserModerationStatus | null = null;
  if (action === 'suspend_pending') {
    if (currentStatus !== 'suspend_pending' && currentStatus !== 'suspended') {
      transitionTo = 'suspend_pending';
    }
  } else if (action === 'throttle') {
    if (currentStatus === 'active' || (currentStatus === 'throttled' && !throttleActive)) {
      transitionTo = 'throttled';
    }
  }

  if (transitionTo) {
    await users.setModerationStatus(userId, transitionTo, {
      throttledUntil:
        transitionTo === 'throttled' ? new Date(now.getTime() + MODERATION_POLICY.throttleDurationMs) : null,
    });
    return { hitsInWindow, action, status: transitionTo };
  }

  return { hitsInWindow, action, status: currentStatus };
}
