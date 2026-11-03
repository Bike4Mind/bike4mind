/**
 * POST /api/v1/files/bulk-delete - delete several files in one call. The public twin of
 * DELETE /api/files/bulk-delete (a POST here: a DELETE body is dropped by many proxies and SDKs).
 * The deletes are shared through `bulkDeleteFilesForUser`, and this handler only maps the published
 * snake_case shape.
 */

import { bulkDeleteFilesContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { bulkDeleteFilesForUser } from '@server/files/bulkDeleteFilesForUser';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

const handler = nextRouteForContract(bulkDeleteFilesContract, {
  rateLimit: perUserRateLimit('POST /api/v1/files/bulk-delete'),
}).post(async (req, res) => {
  // A malformed id is not_found, as on DELETE /api/v1/files/{id}: it never reaches a query that would cast it.
  const requested = [...new Set(req.validated.file_ids)];
  const valid = requested.filter(isValidObjectId);
  const malformed = requested.filter(id => !isValidObjectId(id));

  const results = valid.length > 0 ? await bulkDeleteFilesForUser(req, valid) : undefined;

  return res.json({
    deleted: results?.deleted ?? [],
    unshared: results?.unshared ?? [],
    not_found: [...(results?.notFound ?? []), ...malformed],
    // The raw message can carry internals; the id is what a caller retries on.
    failed: (results?.failed ?? []).map(({ id }) => ({ id, error: 'The file could not be processed' })),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
