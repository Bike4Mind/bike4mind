import { satisfiesMembershipScope, type MembershipActor, type MembershipLake } from './lakeMembership';
import { resolveLakeMembershipScope } from './lakeMembershipScope';
import { recordLakeMembershipChange, type LakeMembershipAuditAdapters } from './recordLakeMembershipChange';
import type { LakeMembershipChangeOrigin } from '@bike4mind/common';

/**
 * One file's tag names either side of a bulk write. The caller already holds both arrays (the
 * before-state is the pre-image its own claiming write returned), so nothing is re-read here -
 * this helper never touches the files collection.
 */
export interface MembershipTransitionFile {
  fabFileId: string;
  /** The FILE's owner: the prefix arm is anchored here, never to the acting user. */
  userId: string;
  beforeTagNames: readonly string[];
  afterTagNames: readonly string[];
}

/**
 * Record a membership event for every (lake, file) pair whose membership ACTUALLY flips across a
 * bulk tag write, and nothing for a file that stays in or stays out.
 *
 * The bulk tag doors (`tagService/remove`, `tagService/update`) rewrite one tag name across every
 * file a user owns, so a single request can move many files across many lakes' prefix arms at
 * once. Without this the change log reads as if those files never moved, and a reader
 * reconstructing membership from it lands on the wrong answer - the reason it exists at all.
 *
 * Takes the files a caller's own writes CLAIMED, not a snapshot it read (see `claimBulkTagRewrite`):
 * two concurrent renames would otherwise each synthesize the same transitions off the same read.
 *
 * Membership is decided by `satisfiesMembershipScope` over `resolveLakeMembershipScope(lake)`, the same
 * predicate the read path runs, rather than by testing the prefix directly: a file that ALSO
 * carries the lake's `datalake:` meta-tag is still a member after losing its prefix tag, and a
 * prefix-only diff would wrongly report it as having left.
 *
 * Best-effort throughout, like `recordLakeMembershipChange` itself: the tag write has already
 * landed by the time this runs, so a failed audit must not surface as a failed rename. Recorded
 * one at a time rather than fanned out - a bulk door can reach thousands of pairs, and the events
 * are independent, so there is nothing to win by opening that many concurrent writes.
 */
export const recordMembershipTransitions = async (
  actor: MembershipActor,
  lakes: readonly MembershipLake[],
  files: readonly MembershipTransitionFile[],
  { db, logger }: LakeMembershipAuditAdapters,
  { origin }: { origin: LakeMembershipChangeOrigin }
): Promise<void> => {
  if (!db.lakeMembershipChangeEvents) return;

  for (const lake of lakes) {
    // `resolveLakeMembershipScope`, not `lakeMembershipScope`: a static registry lake has no
    // creator, and an owned scope over one fails closed to the meta-tag arm - silently dropping
    // the open prefix arm that is most of what a registry lake's membership is.
    const scope = resolveLakeMembershipScope(lake);
    for (const file of files) {
      // `strength` is immaterial to the scope predicate, which reads names only; 0 keeps the
      // synthetic file shaped like the persisted document without inventing a weight.
      const asFile = (names: readonly string[]) => ({
        userId: file.userId,
        tags: names.map(name => ({ name, strength: 0 })),
      });
      const before = satisfiesMembershipScope(scope, asFile(file.beforeTagNames));
      const after = satisfiesMembershipScope(scope, asFile(file.afterTagNames));
      if (before === after) continue;
      await recordLakeMembershipChange(
        { actor, lake, fabFileId: file.fabFileId, action: after ? 'added' : 'removed', origin },
        { db, logger }
      );
    }
  }
};
