/**
 * GET /api/v1/published-pages - list the caller's own published pages, cursor-paginated.
 *
 * The service pages by offset; the opaque cursor carries the next offset so the public shape stays a
 * cursor list.
 */

import { listPublishedPagesContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { listPublishedPages } from '@server/services/publish/managePublishedPages';
import { toPublishedPageResource } from '@server/publish/publishedPageResource';

const CURSOR_SCOPE = 'v1.published-pages';

export default nextRouteForContract(listPublishedPagesContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/published-pages'),
}).get(async (req, res) => {
  const { limit, cursor, q, visibility } = req.validatedQuery;
  let skip = 0;
  if (cursor !== undefined) {
    const after = decodeCursor(cursor, CURSOR_SCOPE);
    if (!/^\d{1,9}$/.test(after)) throw new UnprocessableEntityError('Invalid cursor');
    skip = Number(after);
  }

  const result = await listPublishedPages({ user: req.user, mine: true, limit, skip, q, visibility });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: result.items.map(toPublishedPageResource),
    next_cursor: result.nextSkip === null ? null : encodeCursor(CURSOR_SCOPE, String(result.nextSkip)),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};
