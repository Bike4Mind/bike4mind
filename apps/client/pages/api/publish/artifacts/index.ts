import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { listPublishedPages } from '@server/services/publish/managePublishedPages';

/**
 * GET /api/publish/artifacts - list artifacts visible to the caller.
 * Non-admins see their own + public + their org/project-visible artifacts
 * (buildListVisibilityFilter), minus other owners' rows whose owner is banned, suspended or gone
 * (excludeNonLiveOwners, the check serve applies per request); admins see everything. Summary fields only.
 *
 * Query params (all optional):
 *   mine, sourceArtifactId  - scoping, as before
 *   sourceMessageId         - owner-scoped lookup of the caller's publication of one chat reply
 *   q                       - substring match on title + description (the STORED title; see
 *                             replyTitleBody below for how a reply row's displayed title can differ)
 *   kind, visibility, gate, comments, tag - facet filters
 *   sort                    - newest (default) | oldest | views | versions | updated | title
 *   facets                  - 'true' to also compute the facet counts, in a second aggregation.
 *                             OFF by default, and only honoured together with `mine`: they are
 *                             group-bys with no allowDiskUse over the caller's whole scope, the
 *                             existence check the profile screen makes (limit=1) has no use for
 *                             them, and the only caller that wants them is owner-scoped anyway.
 *   limit, skip             - paging. `limit` defaults to LEGACY_LIMIT so callers written
 *                             before paging existed keep their previous behaviour.
 *
 * Always returns `total` alongside the page, which is what lets a caller tell a full page
 * from a truncated list - the previous hard `$limit: 200` with no count meant the
 * management tab silently stopped showing the oldest artifacts past that mark.
 *
 * On `mine`, each row the caller owns carries `thumbnailUrl` (a short-lived presigned GET, stable
 * within a signing window so the browser can cache it; see thumbnailUrl.ts) once its owner-only
 * thumbnail has rendered. No other listing, and no other route, ever exposes one.
 */

const optionalInt = (value: unknown): number | undefined => {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};
const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const handler = baseApi({
  requiredScopes: [ApiKeyScope.ARTIFACTS_PUBLISH, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
}).get(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { query } = req;
  const result = await listPublishedPages({
    user: req.user,
    sourceArtifactId: optionalString(query.sourceArtifactId),
    sourceMessageId: optionalString(query.sourceMessageId),
    mine: query.mine === 'true' || query.mine === '1',
    facets: query.facets === 'true' || query.facets === '1',
    limit: optionalInt(query.limit),
    skip: optionalInt(query.skip),
    q: optionalString(query.q),
    kind: optionalString(query.kind),
    visibility: optionalString(query.visibility),
    gate: optionalString(query.gate),
    comments: optionalString(query.comments),
    tag: optionalString(query.tag),
    sort: optionalString(query.sort),
  });
  return res.status(200).json({
    artifacts: result.items,
    total: result.total,
    limit: result.limit,
    skip: result.skip,
    facets: result.facets,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
