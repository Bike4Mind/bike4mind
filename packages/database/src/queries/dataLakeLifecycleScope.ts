import {
  DATALAKE_TAG_PREFIX,
  isReservedTagPrefix,
  normalizeTagPrefix,
  type DataLakeMembershipScope,
} from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

/**
 * The ONE membership predicate: a file belongs to a lake on an exact meta-tag match OR on a
 * `fileTagPrefix` match against a file the lake's CREATOR OWNS. Shared by the single-lake browse
 * and every whole-lake lifecycle write, so all of them agree on who is a member - they used to
 * disagree, and a prefix-only file stayed browsable in an archived lake, survived permanent
 * delete with its chunks, and was missing from `fileCount`.
 *
 * Anchored to the creator rather than the caller because `computeDataLakeStats` persists a
 * viewer-independent `fileCount`; an actor-anchored predicate would make the stored count vary
 * by who triggered the recompute.
 *
 * The prefix arm needs an ownership conjunct at all because `fileTagPrefix` is user-chosen and only
 * unique per creator (see DataLakeModel) - a lake in a different org or by a different creator can
 * still register the same prefix. Without the conjunct, minting a lake with prefix `acme:` would
 * permanently delete every file in the database tagged `acme:*`.
 *
 * That conjunct is POSITIVE ownership - `userId` equals the creator - and deliberately NOT
 * "anything the creator can access". A read share must not make someone else's file a member:
 * this predicate drives a hard delete, so riding a share would let a lake owner purge a file that
 * was merely shared with them, and would list it to every visitor of a public lake. The cost is
 * that a prefix-only file an ADMIN uploaded into someone's lake carries the admin's `userId` and
 * is not a member - it survives the teardown and stays in that admin's Files, the safe direction.
 */
export function buildDataLakeMembershipFilter(scope: DataLakeMembershipScope): Record<string, unknown> {
  const metaArm = { 'tags.name': scope.datalakeTag };
  const prefix = normalizeTagPrefix(scope.fileTagPrefix);
  // Fail closed to the meta-tag alone. A reserved-namespace prefix is dropped because it would
  // match every OTHER lake's membership tag, and a scope with no creator has nothing to anchor
  // the prefix arm to - in both cases matching less is the safe direction.
  if (!prefix || isReservedTagPrefix(prefix) || !scope.creatorUserId) {
    return metaArm;
  }
  return {
    $or: [
      metaArm,
      {
        $and: [
          // Anchored so the index on `tags.name` still bounds the scan; escaped because a
          // user-chosen prefix can carry regex metacharacters.
          { 'tags.name': { $regex: new RegExp(`^${escapeRegex(prefix)}`) } },
          { userId: scope.creatorUserId },
        ],
      },
    ],
  };
}

/**
 * Conjoins the membership predicate with a caller's own conditions. Use this instead of spreading
 * `buildDataLakeMembershipFilter` into an object literal whenever those conditions name a top-level
 * Mongo operator.
 *
 * Spreading is a trap: the prefix arm returns a top-level `$or`, so a literal that also names `$or`
 * SILENTLY DELETES the membership predicate (last key wins in JS) and the query degrades to every
 * file in the install. That is a cross-lake read on the health and convergence surfaces, and a
 * convergence wave built from it re-chunks other lakes' documents at this lake's target. There is no
 * type error and no runtime error - the query just widens. Route it through here and the two can
 * only ever be ANDed.
 */
export function buildDataLakeMembershipQuery(
  scope: DataLakeMembershipScope,
  conditions: Record<string, unknown>
): Record<string, unknown> {
  return { $and: [buildDataLakeMembershipFilter(scope), conditions] };
}

/**
 * Datastore mirror of `satisfiesTagPrefix`, NEGATED: matches files carrying no tag that places
 * them under `prefix`. What the backfill migration selects, so it stamps exactly the files the
 * write-door reconciler would have. A parity test asserts the two agree; change them together.
 *
 * The trailing `[\s\S]` in the pattern is the length check - a bare `acme:` is not a category
 * anyone can navigate to, so it does not satisfy `acme:`. It is spelled that way rather than `.`
 * because `.` excludes newlines, which would make `acme:\nfoo` satisfy the predicate but not this
 * filter. Case-sensitive (no `i` flag), matching both the predicate and the read arms the stamp
 * has to become visible to.
 *
 * The second conjunct mirrors the predicate's "a meta-tag is membership, never content" rule. It is
 * unreachable for the prefixes the stamp gate actually clears, since those are outside the
 * `datalake:` namespace - but carrying it means parity holds for ANY prefix rather than only under
 * that precondition, which is one fewer thing for a future caller to get wrong. Case-insensitive,
 * matching the predicate.
 *
 * Returns a top-level filter fragment; spread it alongside the meta-tag arm.
 *
 * Shares its top-level `tags` key with `buildNoOtherLakeMetaTagFilter` below - spreading both
 * together silently keeps only the last one (see that function's own test for the collision).
 * No caller composes them today; if one ever needs to, compose their $elemMatch conditions
 * directly instead of spreading both objects.
 */
export function buildLacksContentPrefixTagFilter(prefix: string): Record<string, unknown> {
  return {
    tags: {
      $not: {
        $elemMatch: {
          $and: [
            { name: { $regex: new RegExp(`^${escapeRegex(prefix)}[\\s\\S]`) } },
            { name: { $not: new RegExp(`^${DATALAKE_TAG_PREFIX}`, 'i') } },
          ],
        },
      },
    },
  };
}

/**
 * Matches files carrying no lake-membership meta-tag OTHER than `datalakeTag` itself.
 *
 * `addFileToLake` has no exclusivity check, so one file can carry more than one lake's meta-tag at
 * once. A query that needs to tell "mine, and only mine" from "mine, but also a co-owning lake's"
 * spreads this alongside a membership filter - see `hasArchivedMemberExclusiveToDataLakeTag`'s own
 * doc for why that distinction matters there.
 *
 * The namespace test is case-INSENSITIVE, roughly matching `isDataLakeTagName` (@bike4mind/common)
 * - a `DATALAKE:other` tag is still another lake's membership however it is cased (that helper
 * also trims whitespace, which this regex does not; a legacy whitespace-padded tag is outside both
 * this function's and the rest of this file's namespace checks alike).
 *
 * The "other than mine" test is exact and case-SENSITIVE, the same comparison
 * `buildDataLakeMembershipFilter`'s meta arm uses to decide a row is mine at all - both sides must
 * use the SAME exactness or they could disagree on what "mine" is. One deliberate consequence: a
 * mixed-case variant of THIS lake's own tag is treated as another lake's (excluded from "mine"),
 * not folded back to it - degenerate but safe, since no lake can hold a non-canonical meta-tag in
 * the first place.
 *
 * A document with no `tags` at all matches ($not is true on a missing field), which is correct: it
 * carries no other lake's tag. It cannot widen anything, since every membership arm requires one.
 *
 * A bare `datalake:` element (no suffix) would also satisfy the namespace regex and count as
 * "another lake's" - unreachable in practice, since the write paths that mint a meta-tag always
 * append a real identifier after the prefix, never the bare prefix alone.
 *
 * Shares its top-level `tags` key with `buildLacksContentPrefixTagFilter` above - see that
 * function's own doc for the composition hazard this creates for a future caller of both.
 */
export function buildNoOtherLakeMetaTagFilter(datalakeTag: string): Record<string, unknown> {
  return {
    tags: {
      $not: {
        $elemMatch: {
          name: { $regex: new RegExp(`^${DATALAKE_TAG_PREFIX}`, 'i'), $ne: datalakeTag },
        },
      },
    },
  };
}
