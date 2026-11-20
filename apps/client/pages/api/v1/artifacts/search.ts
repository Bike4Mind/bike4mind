/**
 * GET /api/v1/artifacts/search - full-text search over the caller's own artifacts, cursor-paginated.
 * The public twin of GET /api/artifacts/search, which pages by offset; here order is by _id so a page
 * boundary holds while rows are added or removed around it.
 */

import { searchArtifactsContract } from '@bike4mind/common';
import { artifactRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toPublicArtifact } from '@server/artifacts/toPublicArtifact';

const CURSOR_SCOPE = 'v1.artifacts.search';

const handler = nextRouteForContract(searchArtifactsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/artifacts/search'),
}).get(async (req, res) => {
  const { q, type, limit, cursor } = req.validatedQuery;
  const beforeId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last _id this endpoint served, so anything else was not minted here.
  if (beforeId !== undefined && !isValidObjectId(beforeId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  const page = await artifactRepository.searchOwnedBeforeId(req.user.id, q, { type, beforeId, limit });
  const lastId = page.data.at(-1)?._id;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: page.data.map(artifact => toPublicArtifact(artifact, null)),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
