import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveAccessibleLakes, queryDataLakeTagCounts } from '@server/dataLakes';

/**
 * GET /api/data-lakes/tag-counts
 *
 * Tag counts for the Data Lakes tag tree (consolidates the former
 * `/api/opti/tag-counts` twin). Access is lake-scoped via
 * `resolveAccessibleLakes` - same rationale as `articles.ts`: the
 * `EnableDataLakes` flag stays on the lake-management/ingestion surface only.
 */
const handler = baseApi().get(async (req: Request, res) => {
  const lakes = await resolveAccessibleLakes(req);
  const result = await queryDataLakeTagCounts(req, lakes);
  return res.json(result);
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
