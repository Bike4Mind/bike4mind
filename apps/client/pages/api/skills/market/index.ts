// apps/client/pages/api/skills/market/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { memberOrgIdsFor } from '@server/skillMarket/market';
import { searchListings, type MarketSearchParams, type MarketSort } from '@server/skillMarket/search';

const SORTS = new Set<MarketSort>(['relevance', 'top', 'imports', 'new', 'updated']);

/** GET /api/skills/market - browse and search approved listings visible to the caller. */
const handler = baseApi({ auth: 'jwtOnly' }).get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
  const { q, scope, tags, tools, minRating, sort, page = '1', limit = '24' } = req.query;

  const params: MarketSearchParams = {
    q: typeof q === 'string' ? q : undefined,
    scope: scope === 'public' || scope === 'org' ? (scope as 'public' | 'org') : undefined,
    tags:
      typeof tags === 'string' && tags
        ? tags
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 5)
        : undefined,
    tools: tools === 'with' || tools === 'without' ? (tools as 'with' | 'without') : undefined,
    minRating: Math.min(Math.max(Number(minRating) || 0, 0), 5) || undefined,
    sort: SORTS.has(sort as MarketSort) ? (sort as MarketSort) : q ? 'relevance' : 'top',
    page: Math.max(parseInt(page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(limit, 10) || 24, 1), 50),
  };

  res.json(await searchListings(await memberOrgIdsFor(req.user!.id), params));
});

export default handler;
