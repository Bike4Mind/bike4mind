import { type OverwatchLane } from '@bike4mind/common';

/**
 * The analytics lane a synthetic user's events are stamped with, as a flat `metadata.lane`.
 *
 * Test personas and accounts on a configured test domain (`User.isSynthetic`, decided at signup in
 * funnel.ts) used to be skipped by the funnel emits: a persona run left no trace to check, and
 * nothing said whether it had been excluded or had never happened. Marked instead, they arrive as
 * their own lane, which a consumer can keep apart from real users without losing sight of them.
 *
 * Only the synthetic lane is stamped. A real user's events carry no `lane`, and older events carry
 * none either, so a consumer must read an absent lane as "not marked", never as a verified real
 * user: nothing classifies internal staff yet, which a `real` stamp would claim to have done.
 * Consumers read this value back out of stored history, so it must not change. `satisfies` ties it
 * to the per-user rows' `lane` enum and the partial index filtered on it.
 */
export const SYNTHETIC_LANE = 'synthetic' satisfies OverwatchLane;

/** `{ lane: 'synthetic' }` for a synthetic user, and nothing for anyone else. */
export function laneMetadata(user: { isSynthetic?: boolean | null } | null | undefined): {
  lane?: typeof SYNTHETIC_LANE;
} {
  return user?.isSynthetic === true ? { lane: SYNTHETIC_LANE } : {};
}
