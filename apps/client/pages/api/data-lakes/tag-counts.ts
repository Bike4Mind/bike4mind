import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { resolveAccessibleLakes, queryDataLakeTagCounts } from '@server/dataLakes';

/**
 * GET /api/data-lakes/tag-counts
 *
 * Tag counts for the Data Lakes tag tree (consolidates the former
 * `/api/opti/tag-counts` twin). Access is lake-scoped via
 * `resolveAccessibleLakes` - same rationale as `articles.ts`: the
 * `EnableDataLakes` flag stays on the lake-management/ingestion surface only.
 *
 * `tagCounts` rows are tag-tree PATHS, not stored tags: `{ tag, count, fileCount }`, where `count`
 * is files tagged exactly `tag` and `fileCount` is distinct files at or under it. Every ancestor
 * path of a stored tag gets a row, so a row with `count: 0` is an ancestor-only path that no file
 * carries itself - an API-key caller listing tags should skip those (see countDataLakeTagsByPrefix).
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES }).get(async (req: Request, res) => {
  const lakes = await resolveAccessibleLakes(req);
  const result = await queryDataLakeTagCounts(req, lakes);
  return res.json(result);
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
