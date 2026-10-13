/**
 * POST /api/v1/transcriptions/uploads - mint a presigned POST for one audio file. The public twin of
 * POST /api/ai/transcribe/init; both call createTranscribeUpload.
 */

import { createTranscriptionUploadContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { createTranscribeUpload, PRESIGNED_POST_EXPIRY_SECONDS } from '@server/transcribe/transcribe';
import { toPublicTranscribeError } from '@server/transcribe/toPublicTranscribeError';

const handler = nextRouteForContract(createTranscriptionUploadContract, {
  rateLimit: perUserRateLimit('POST /api/v1/transcriptions/uploads'),
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
