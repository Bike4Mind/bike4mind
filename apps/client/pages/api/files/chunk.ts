import { MIN_PASSAGE_TOKEN_TARGET, OVERSIZED_PASSAGE_TOKEN_THRESHOLD } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Request } from 'express';
import { FILES_WRITE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import { requestFileRechunk } from '@server/files/requestFileRechunk';

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES }).post(
  asyncHandler(async (req: Request<{ fabFileId: string; chunkSize?: string }>, res) => {
    const { fabFileId, chunkSize } = req.body;
    if (!fabFileId || !chunkSize) throw new BadRequestError('Missing parameters: fabFileId or chunkSize');
    // chunkSize is the passage target in TOKENS. Reject a malformed value here with a clear
    // 400 - the queue consumer fails soft on bad input (fabFileChunk.ts), which would silently
    // chunk at the default instead of what the caller asked for.
    if (!/^\d+$/.test(String(chunkSize)) || Number(chunkSize) < 1) {
      throw new BadRequestError('chunkSize must be a positive integer (tokens)');
    }
    // This payload value overrides the resolved chunk-size policy entirely (fabFileChunk.ts:
    // requestedPassageTokenTarget = chunkSize ?? resolvedChunkPolicy.value), so it is the one
    // door the policy's own ceiling (DefaultChunkSize's max) cannot reach. Enforce the same
    // detection-threshold ceiling here, or a caller can still make "Rebuild passages"
    // non-convergent for this file. Detection is `$gt`, so the threshold itself is accepted.
    if (Number(chunkSize) > OVERSIZED_PASSAGE_TOKEN_THRESHOLD) {
      throw new BadRequestError(`chunkSize must not exceed ${OVERSIZED_PASSAGE_TOKEN_THRESHOLD} tokens`);
    }
    // Below MIN_PASSAGE_TOKEN_TARGET, the chunker (effectiveChunkTokenLimit) silently raises the
    // value instead of honoring it - reject here rather than letting a caller's request get
    // ignored with no signal, same reasoning as the ceiling above.
    if (Number(chunkSize) < MIN_PASSAGE_TOKEN_TARGET) {
      throw new BadRequestError(`chunkSize must be at least ${MIN_PASSAGE_TOKEN_TARGET} tokens`);
    }

    const outcome = await requestFileRechunk(req, { fabFileId, chunkSize });
    if (outcome.status === 'not_found') throw new NotFoundError('FabFile not found');
    if (outcome.status === 'denied') throw new BadRequestError('Unauthorized');
    if (outcome.status === 'already_chunking') throw new BadRequestError('FabFile is currently being chunked');

    return res.json({ messageId: outcome.messageId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
