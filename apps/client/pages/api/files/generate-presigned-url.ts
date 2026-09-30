import {
  FileGeneratePresignedUrlRequestInput,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
} from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { createPresignedUpload } from '@server/files/createPresignedUpload';

// SPA-internal door. The public API-key door is POST /api/v1/files (same admission logic).
const handler = baseApi().post(
  asyncHandler<unknown, FileGeneratePresignedUrlResponseType, FileGeneratePresignedUrlRequestInputType>(
    async (req, res) => {
      const data = FileGeneratePresignedUrlRequestInput.parse(req.body);
      const { url, fileId, fileKey } = await createPresignedUpload(req, data);
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
