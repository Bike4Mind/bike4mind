/**
 * POST /api/v1/transcriptions/uploads - mint a presigned POST for one audio file. The public twin of
 * POST /api/ai/transcribe/init; both call createTranscribeUpload.
 */

import { createTranscriptionUploadContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { createTranscribeUpload, PRESIGNED_POST_EXPIRY_SECONDS } from '@server/transcribe/transcribe';
import { toPublicTranscribeError } from '@server/transcribe/toPublicTranscribeError';

const handler = nextRouteForContract(createTranscriptionUploadContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    bucket: 'POST /api/v1/transcriptions/uploads',
  }),
}).post(async (req, res) => {
  const { mime_type, file_size } = req.validated;
  const { url, fields, fileKey } = await createTranscribeUpload({
    userId: req.user.id,
    mimeType: mime_type,
    fileSize: file_size,
  }).catch(err => {
    throw toPublicTranscribeError(err);
  });

  return res.status(201).json({
    upload_url: url,
    upload_fields: fields,
    file_key: fileKey,
    expires_at: new Date(Date.now() + PRESIGNED_POST_EXPIRY_SECONDS * 1000).toISOString(),
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
