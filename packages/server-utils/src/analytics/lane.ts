import { type OverwatchLane } from '@bike4mind/common';

/**
 * The analytics lane a synthetic user's events are stamped with, as a flat `metadata.lane`.
 *
 * Test personas and accounts on a configured test domain (`User.isSynthetic`, decided at signup in
 * funnel.ts) used to be skipped by the funnel emits: a persona run left no trace to check, and
 * nothing said whether it had been excluded or had never happened. Marked instead, they arrive as
 * their own lane, which a consumer can keep apart from real users without losing sight of them.
 *
 * Consumers read this value back out of stored history, so it must not change. `satisfies` ties it
 * to the per-user rows' `lane` enum and the partial index filtered on it.
 */
export const SYNTHETIC_LANE = 'synthetic' satisfies OverwatchLane;

/**
 * The `metadata` key an internal account's events carry, always as `true`: the team's own
 * accounts (`User.isInternal`, or an admin), whose use of the product is not a customer's. A
 * separate key rather than a second `lane` value, because it is the mark other emitters already
 * send for the same accounts, so one reader covers them all.
 */
export const INTERNAL_MARK = 'internal';

/** The account flags a mark is read from. Each is optional: an absent flag is not set. */
export type LaneAccount =
  | {
      isSynthetic?: boolean | null;
      isInternal?: boolean | null;
      isAdmin?: boolean | null;
    }
  | null
  | undefined;

/** What laneMetadata adds to an event's metadata: at most one of the two marks. */
export type LaneMark = { lane?: typeof SYNTHETIC_LANE; [INTERNAL_MARK]?: true };

/**
 * The mark for a user's events, resolved from the account when the event is sent:
 *
 *  - `{ lane: 'synthetic' }` for a synthetic user. It wins over internal: a staff account
 *    running as a test persona is test traffic first, and the synthetic lane is the one a
 *    consumer already keeps apart.
 *  - `{ internal: true }` for an internal account: `isInternal`, or an admin. Admins are read
 *    live from the flag rather than through `isInternal`, so a user made admin is marked from
 *    their next event without anything having to set the flag.
 *  - `{}` for anyone else.
 *
 * Nothing is stamped for a real user, and older events carry nothing either, so a consumer must
 * read an absent mark as "not marked", never as a verified customer. No `internal: false` is ever
 * sent, for the same reason.
 */
export function laneMetadata(user: LaneAccount): LaneMark {
  if (user?.isSynthetic === true) return { lane: SYNTHETIC_LANE };
  if (user?.isInternal === true || user?.isAdmin === true) return { [INTERNAL_MARK]: true };
  return {};
}

/** Whether laneMetadata marks this account at all: synthetic or internal. */
export function isLaneMarked(user: LaneAccount): boolean {
  return Object.keys(laneMetadata(user)).length > 0;
}
