import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveAccessibleLakes, queryDataLakeArticles, type DataLakeArticlesQuery } from '@server/dataLakes';
import { lakeAccessEventRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

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
 *
 * Browse scope is resolved separately from semantic-search's retrieval scope and is the wider
 * of the two - see the difference list in server/dataLakes/index.ts.
 */
const handler = baseApi().get(async (req: Request<{}, unknown, unknown, DataLakeArticlesQuery>, res) => {
  const lakes = await resolveAccessibleLakes(req);
  const result = await queryDataLakeArticles(req, lakes, req.query);

  // Best-effort audit write, only when something was actually returned - an empty
  // result (no accessible lakes, or a deep-link miss) reflects no lake content, so no event.
  const files = result.data as Array<{ id: string; tags?: { name: string }[] }>;
  if (files.length > 0) {
    // Express hands back string[] for a repeated ?search=, but the type only promises string -
    // narrow explicitly rather than let an array reach record()'s queryText.trim() and get
    // silently swallowed by the fire-and-forget catch.
    const rawSearch = req.query.search as string | string[] | undefined;
    const searchTerm = Array.isArray(rawSearch) ? rawSearch[0] : rawSearch;
    dataLakeService.recordLakeAccessEvent(
      lakeAccessEventRepository,
      {
        principalKind: 'user',
        principalId: req.user.id,
        resolvedLakeIds: dataLakeService.attributeAccessedLakeIds(
          files.map(f => f.tags?.map(t => t.name) ?? []),
          lakes
        ),
        fileIds: files.map(f => f.id),
        surface: 'data-lake-articles',
        ...(searchTerm ? { queryText: searchTerm } : {}),
      },
      req.logger
    );
  }

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
