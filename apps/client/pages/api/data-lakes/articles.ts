import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveAccessibleLakes, queryDataLakeArticles, type DataLakeArticlesQuery } from '@server/dataLakes';
import { adminSettingsRepository, lakeAccessEventRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { normalizeId } from '@bike4mind/utils/normalizeId';

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
    // The deep-link branch (?id=) is authorized via isFileInAccessibleLake, so the ONE file it
    // returns is guaranteed lake content even when prefix-matched (no recoverable tag) - the
    // fallback stays sound there, same as semantic-search.ts. The list/search branch has no such
    // guarantee: it is a mixed corpus (owned + shared + org-shared + data lake, since this route
    // never sets restrictToDataLake), so a hit with no recoverable tag may be the caller's own
    // private file - never fall back there, and skip the row entirely if nothing is attributable.
    const isDeepLink = !!req.query.id;
    const resolvedLakeIds = dataLakeService.attributeAccessedLakeIds(
      files.map(f => f.tags?.map(t => t.name) ?? []),
      lakes,
      { allowFullScopeFallback: isDeepLink }
    );
    if (isDeepLink || resolvedLakeIds.length > 0) {
      // Express hands back string[] for a repeated ?search=, but the type only promises string -
      // narrow explicitly rather than let an array reach record()'s queryText.trim() and get
      // silently swallowed by the fire-and-forget catch.
      const rawSearch = req.query.search as string | string[] | undefined;
      const searchTerm = Array.isArray(rawSearch) ? rawSearch[0] : rawSearch;
      // Awaited (never rethrows - see recordLakeAccessEvent's doc comment): this is a per-request
      // serverless route, so the write must land before the response ends, not race a post-response
      // freeze of the execution environment.
      await dataLakeService.recordLakeAccessEvent(
        lakeAccessEventRepository,
        {
          principalKind: 'user',
          principalId: req.user.id,
          organizationId: normalizeId(req.user.organizationId),
          resolvedLakeIds,
          fileIds: files.map(f => f.id),
          surface: 'data-lake-articles',
          ...(searchTerm ? { queryText: searchTerm } : {}),
        },
        req.logger,
        adminSettingsRepository
      );
    }
  }

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
