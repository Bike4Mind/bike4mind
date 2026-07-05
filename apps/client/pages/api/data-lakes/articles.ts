import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveAccessibleLakes, queryDataLakeArticles, type DataLakeArticlesQuery } from '@server/dataLakes';

/**
 * GET /api/data-lakes/articles
 *
 * THE data-lake browse endpoint (consolidates the former `/api/opti/articles`
 * twin). Access is lake-scoped: `resolveAccessibleLakes` returns the caller's
 * dynamic DB lakes plus any static registry lakes whose declared
 * `requiredUserTag`/`requiredEntitlement` they satisfy - no accessible lakes
 * means empty results. Deliberately NOT gated on the `EnableDataLakes` admin
 * flag: that flag gates the lake-management/ingestion surface, and the former
 * product-namespace twin was reachable without it.
 */
const handler = baseApi().get(async (req: Request<{}, unknown, unknown, DataLakeArticlesQuery>, res) => {
  const lakes = await resolveAccessibleLakes(req);
  const result = await queryDataLakeArticles(req, lakes, req.query);
  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
