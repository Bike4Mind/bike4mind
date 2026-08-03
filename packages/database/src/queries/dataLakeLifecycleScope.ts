import { isReservedTagPrefix, normalizeTagPrefix, type DataLakeMembershipScope } from '@bike4mind/common';
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
 * The prefix arm needs an ownership conjunct at all because `fileTagPrefix` is user-chosen with no
 * uniqueness constraint (see DataLakeModel). Without it, minting a lake with prefix `acme:`
 * would permanently delete every file in the database tagged `acme:*`.
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
 * `satisfiesTagPrefix` also excludes `datalake:*` tags; there is no conjunct for that here because
 * callers reach this only for a prefix `decideStampPrefix` cleared, which rules out the reserved
 * namespace. A tag cannot then start with both `prefix` and `datalake:` - one would have to be a
 * prefix of the other, and the only prefix inside that namespace ending in ':' is `datalake:`
 * itself. The parity test covers the case rather than leaving it to this argument.
 *
 * Returns a top-level filter fragment; spread it alongside the meta-tag arm.
 */
export function buildLacksContentPrefixTagFilter(prefix: string): Record<string, unknown> {
  return {
    tags: { $not: { $elemMatch: { name: { $regex: new RegExp(`^${escapeRegex(prefix)}[\\s\\S]`) } } } },
  };
}
