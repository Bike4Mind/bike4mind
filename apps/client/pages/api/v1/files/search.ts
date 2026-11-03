/**
 * GET /api/v1/files/search - find files by name, across the caller's own, shared and (with
 * datalake:read) data-lake files. The public twin of GET /api/files/search; the visibility scope is
 * shared through `searchFilesForRequest`, and this handler only maps the published snake_case shape.
 */

import { searchFilesContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { searchFilesForRequest } from '@server/files/searchFilesForRequest';
import { toPublicFile } from '@server/files/toPublicFile';

const handler = nextRouteForContract(searchFilesContract, {
  // A search costs no daily slot, like every sibling v1 read. Only safe methods are exempted, and
  // the per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/files/search'),
}).get(async (req, res) => {
  const { q, type, limit } = req.validatedQuery;

  const result = await searchFilesForRequest(req, {
    ...(q !== undefined && { search: q }),
    ...(type !== undefined && { filters: { type } }),
    pagination: { page: 1, limit },
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ files: result.data.map(toPublicFile) });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
