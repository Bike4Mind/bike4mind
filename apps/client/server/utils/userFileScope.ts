import { getDataLakeTags } from '@bike4mind/common';

/**
 * The set of files this user can reach, for the surfaces that count them and the one that lists
 * them: GET /api/files/tags (per-tag-document `fileCount`), the `tagCounts`/Tags-view half of
 * GET /api/files/tags/counts, and GET /api/files/search. These three MUST agree - passing
 * different scopes makes a badge disagree with the list beside it, which is exactly the class of
 * bug deriving the counts was meant to end.
 *
 * This returns the WHO, not the whether: the count aggregates widen on the mere presence of a
 * scope object, but the list path widens only when `includeShared` is also true
 * (buildFabFileSearchQuery reaches buildOwnershipConditions on that flag alone). So a list caller
 * has to pass `includeShared: true` alongside this; passing this by itself yields an owner-only
 * list beside widened badges. One shared helper removes the drift in the tag/group/lake values,
 * not in that flag.
 *
 * `dataLakeTags` reaches an ownership-bypass arm in buildOwnershipConditions, so it must stay the
 * registry-derived set for lakes this user can reach - never the user's raw tags.
 *
 * WORKSPACES (Home/Overview) is the deliberate exception, NOT covered by "the three agree": its
 * `workspaceTagCounts`/`namespaceCounts` pair additionally opts into `excludePersonalShares` - see
 * ./counts.ts and buildOwnershipConditions for the full why and which response fields carry it.
 * This function itself stays exclusion-free; each caller decides.
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
