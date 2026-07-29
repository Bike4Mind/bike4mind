import { getDataLakeTags } from '@bike4mind/common';

/**
 * The file set a per-tag count is taken over.
 *
 * Two endpoints report per-tag counts and MUST agree: GET /api/files/tags, whose `fileCount` is
 * derived per tag document, and GET /api/files/tags/counts, which backs the tag tree. Passing
 * different scopes makes the sidebar badge and the tag card disagree for the same tag, which is
 * exactly the class of bug deriving the count was meant to end. Building the scope in one place
 * means a future edit cannot drift one caller without the other.
 *
 * `dataLakeTags` reaches an ownership-bypass arm in buildOwnershipConditions, so it must stay the
 * registry-derived set for lakes this user can reach - never the user's raw tags.
 */
// `groups` and `tags` are nullable on IUserDocument, not merely optional - a user record can hold
// an explicit null, so the parameter has to admit it rather than only `undefined`.
export function buildTagCountScope(user: { groups?: string[] | null; tags?: string[] | null }): {
  userGroups: string[];
  dataLakeTags: string[];
} {
  return {
    userGroups: user.groups ?? [],
    dataLakeTags: getDataLakeTags(user.tags ?? []),
  };
}
