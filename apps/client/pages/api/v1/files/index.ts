/**
 * POST /api/v1/files - start a file upload: register a `pending` file and presign the PUT for
 * its bytes. Admission is shared with the SPA-internal generate-presigned-url route via
 * `createPresignedUpload`; this handler only maps the published snake_case shape.
 */

import { createFileUploadContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { createPresignedUpload, PRESIGNED_UPLOAD_EXPIRES_IN } from '@server/files/createPresignedUpload';

const handler = nextRouteForContract(createFileUploadContract).post(async (req, res) => {
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

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
