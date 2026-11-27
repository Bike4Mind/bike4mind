import {
  MODERATION_SEVERE_CATEGORIES,
  type IModerationHit,
  type IUserRepository,
  type UserModerationStatus,
} from '@bike4mind/common';

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
  /** The status this hit moved the user into, or null when it changed nothing. */
  transitionedTo: UserModerationStatus | null;
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
      automatic: true,
      throttledUntil:
        transitionTo === 'throttled' ? new Date(now.getTime() + MODERATION_POLICY.throttleDurationMs) : null,
    });
    return { hitsInWindow, action, status: transitionTo, transitionedTo: transitionTo };
  }

  return { hitsInWindow, action, status: currentStatus, transitionedTo: null };
}

/** Why a moderation hit is alerted on. Ordinary hits are not: they escalate through the policy above. */
export type ModerationEscalationReason = 'suspend_pending' | 'severe_category';

/**
 * The liveops alert for one moderation hit. Carries no prompt text and no quest id: the alert links
 * to the admin review list, where the hit history lives.
 */
export interface ModerationEscalationAlert {
  userId: string;
  reasons: ModerationEscalationReason[];
  categories: string[];
  source: IModerationHit['source'];
  hitsInWindow: number;
}

/**
 * The alert a hit raises, or null for an ordinary hit. A user is alerted once on entering
 * `suspend_pending` (the transition, not every later hit), and on every hit carrying a
 * {@link MODERATION_SEVERE_CATEGORIES} label. Pure.
 */
export function moderationEscalationAlert(
  userId: string,
  hit: Pick<IModerationHit, 'categories' | 'source'>,
  decision: Pick<ApplyModerationHitResult, 'hitsInWindow' | 'transitionedTo'>
): ModerationEscalationAlert | null {
  const reasons: ModerationEscalationReason[] = [];
  if (decision.transitionedTo === 'suspend_pending') reasons.push('suspend_pending');
  if (hit.categories.some(category => MODERATION_SEVERE_CATEGORIES.includes(category))) reasons.push('severe_category');
  if (reasons.length === 0) return null;
  return { userId, reasons, categories: hit.categories, source: hit.source, hitsInWindow: decision.hitsInWindow };
}
