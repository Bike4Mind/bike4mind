/**
 * POST /api/v1/files/{id}/chunk - queue the chunking and embedding pipeline for a file. The public
 * twin of POST /api/files/chunk; loading, authorization and enqueueing are shared through
 * `requestFileRechunk`. The range check on `chunk_size` lives in the contract's schema.
 */

import { chunkFileContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { requestFileRechunk } from '@server/files/requestFileRechunk';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { ConflictError, InternalServerError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const handler = nextRouteForContract(chunkFileContract, {
  rateLimit: perUserRateLimit('POST /api/v1/files/[id]/chunk'),
}).post(async (req, res) => {
  const { id } = req.validatedParams;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(id)) throw new NotFoundError('File not found');

  const outcome = await requestFileRechunk(req, { fabFileId: id, chunkSize: req.validated.chunk_size });
  // A file you cannot edit reads the same as one that does not exist, so ids cannot be probed.
  if (outcome.status === 'not_found' || outcome.status === 'denied') throw new NotFoundError('File not found');
  if (outcome.status === 'already_chunking') throw new ConflictError('File is already being chunked');

  if (!outcome.messageId) throw new InternalServerError('Chunk job was not queued');

  return res.json({ message_id: outcome.messageId });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
