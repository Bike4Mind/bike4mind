import { getDataLakeTags } from '@bike4mind/common';

/**
 * The set of files this user can reach, for the surfaces that count them and the one that lists
 * them. Three endpoints MUST agree: GET /api/files/tags (whose `fileCount` is derived per tag
 * document), GET /api/files/tags/counts (which backs the tag tree and the workspace rows), and
 * GET /api/files/search (the list those counts are read against). Passing different scopes makes
 * a badge disagree with the list beside it, which is exactly the class of bug deriving the counts
 * was meant to end - and the list is the one the others are compared to, so drift there breaks the
 * headline claim rather than just badge-versus-tree. Building the scope in one place means a
 * future edit cannot drift one caller without the others.
 *
 * `dataLakeTags` reaches an ownership-bypass arm in buildOwnershipConditions, so it must stay the
 * registry-derived set for lakes this user can reach - never the user's raw tags.
 */
// `groups` and `tags` are nullable on IUserDocument, not merely optional - a user record can hold
// an explicit null, so the parameter has to admit it rather than only `undefined`.
export function buildUserFileScope(user: { groups?: string[] | null; tags?: string[] | null }): {
  userGroups: string[];
  dataLakeTags: string[];
} {
  return {
    userGroups: user.groups ?? [],
    dataLakeTags: getDataLakeTags(user.tags ?? []),
  };
}
