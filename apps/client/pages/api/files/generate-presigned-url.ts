import {
  FileGeneratePresignedUrlRequestInput,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
} from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { createPresignedUpload } from '@server/files/createPresignedUpload';
import { FILES_WRITE_OR_GENERATE_SCOPES, GENERATE_UPLOAD_MARKER, isBareGenerateUpload } from '@server/files/fileScopes';
import { BARE_UPLOAD_MIME_TYPE } from '@server/files/generateUploadMarker';
import { assertBareGenerateUploadBody } from '@server/files/bareGenerateUpload';

// An ai:generate key without files:write may only stage a bare PNG (the image-edit flow), marked so
// GET /api/files/{id} can later serve it back to that key alone. Its PUT must send
// `Content-Type: image/png`, `Content-Length` equal to the declared fileSize and `If-None-Match: *`,
// all signed into the URL, or S3 rejects it.
// SPA-internal door. The public API-key door is POST /api/v1/files (same admission logic).
const handler = baseApi({ requiredScopes: FILES_WRITE_OR_GENERATE_SCOPES }).post(
  asyncHandler<unknown, FileGeneratePresignedUrlResponseType, FileGeneratePresignedUrlRequestInputType>(
    async (req, res) => {
      const bare = isBareGenerateUpload(req);
      if (bare) assertBareGenerateUploadBody(req.body);
      const data = FileGeneratePresignedUrlRequestInput.parse(req.body);
      const { url, fileId, fileKey } = await createPresignedUpload(
        req,
        data,
        bare
          ? { sourceMetadata: { uploadedVia: GENERATE_UPLOAD_MARKER }, contentType: BARE_UPLOAD_MIME_TYPE }
          : undefined
      );
      return res.json({ url, fileId, fileKey });
    }
  )
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
