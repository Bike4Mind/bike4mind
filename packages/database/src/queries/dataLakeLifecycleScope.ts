import { isReservedTagPrefix, normalizeTagPrefix, type DataLakeMembershipScope } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { buildBaseAccessConditions } from './baseAccessConditions';

/**
 * The ONE membership predicate: a file belongs to a lake on an exact meta-tag match OR on a
 * `fileTagPrefix` match that the lake's CREATOR can access. Shared by the single-lake browse
 * and every whole-lake lifecycle write, so all of them agree on who is a member - they used to
 * disagree, and a prefix-only file stayed browsable in an archived lake, survived permanent
 * delete with its chunks, and was missing from `fileCount`.
 *
 * Anchored to the creator rather than the caller because `computeDataLakeStats` persists a
 * viewer-independent `fileCount`; an actor-anchored predicate would make the stored count vary
 * by who triggered the recompute.
 *
 * The prefix arm needs an access conjunct at all because `fileTagPrefix` is user-chosen with no
 * uniqueness constraint (see DataLakeModel). Without it, minting a lake with prefix `acme:`
 * would permanently delete every file in the database tagged `acme:*`.
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
  const baseAccess = buildBaseAccessConditions(scope.creatorUserId, scope.creatorGroupIds ?? []);
  return {
    $or: [
      metaArm,
      {
        $and: [
          // Anchored so the index on `tags.name` still bounds the scan; escaped because a
          // user-chosen prefix can carry regex metacharacters.
          { 'tags.name': { $regex: new RegExp(`^${escapeRegex(prefix)}`) } },
          { $or: baseAccess },
        ],
      },
    ],
  };
}
