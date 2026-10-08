/**
 * GET  /api/v1/files - list the caller's own files, cursor-paginated, with an optional name search.
 * POST /api/v1/files - start a file upload: register a `pending` file and presign the PUT for its
 * bytes. Admission is shared with the SPA-internal generate-presigned-url route via
 * `createPresignedUpload`; these handlers only map the published snake_case shape.
 */

import { createFileUploadContract, listFilesContract } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@server/utils/objectId';
import { UnprocessableEntityError } from '@server/utils/errors';
import { createPresignedUpload, PRESIGNED_UPLOAD_EXPIRES_IN } from '@server/files/createPresignedUpload';
import { toPublicFileSummary } from '@server/files/toPublicFile';

const CURSOR_SCOPE = 'v1.files';
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

const listRoute = nextRouteForContract(listFilesContract, {
  rateLimit: perUserRateLimit('GET /api/v1/files'),
}).get(async (req, res) => {
  const { limit, cursor, search } = req.validatedQuery;
  const afterId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last id this endpoint served, so anything else was not minted here.
  if (afterId !== undefined && !isValidObjectId(afterId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  const page = await fabFileRepository.listOwnedAfterId(req.user.id, { afterId, limit, search });
  const lastId = page.data.at(-1)?.id;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: page.data.map(toPublicFileSummary),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const createRoute = nextRouteForContract(createFileUploadContract, {
  rateLimit: perUserRateLimit('POST /api/v1/files'),
}).post(async (req, res) => {
  const { file_name, mime_type, file_size } = req.validated;
  const { url, fileId } = await createPresignedUpload(req, {
    fileName: file_name,
    mimeType: mime_type,
    fileSize: file_size,
  });

  return res.status(201).json({
    id: fileId,
    upload_url: url,
    upload_url_expires_at: new Date(Date.now() + PRESIGNED_UPLOAD_EXPIRES_IN * 1000).toISOString(),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
