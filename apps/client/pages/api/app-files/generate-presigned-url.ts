import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AppFileEvents,
  FileGeneratePresignedUrlRequestInput,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
} from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { Resource } from 'sst';

const s3Client = new S3Client();

const handler = baseApi().post(
  asyncHandler<unknown, FileGeneratePresignedUrlResponseType, FileGeneratePresignedUrlRequestInputType>(
    async (req, res) => {
      const userId = req.user?.id;
      const data = FileGeneratePresignedUrlRequestInput.parse(req.body);

      const ext = mime.extension(data.mimeType);
      if (!ext) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);

      let fileKey = `${uuidv4()}.${ext}`;
      if (data.path) {
        const filePath = data.path.endsWith('/') ? data.path : `${data.path}/`;
        fileKey = `${filePath}${fileKey}`;
      }

      const command = new PutObjectCommand({
        Bucket: Resource.appFilesBucket.name,
        Key: fileKey,
      });

      const file = await AppFile.create({
        userId: req.user.id,
        name: data.fileName,
        size: data.fileSize,
        path: fileKey,
        mimeType: data.mimeType,
        status: 'pending',
        tags: [],
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: 600, // 10 minutes
      });

      await logEvent(
        { userId, type: AppFileEvents.CREATE_APP_FILE, metadata: { id: file.id } },
        { ability: req.ability }
      );

      return res.json({ url: presignedUrl, fileId: file.id, fileKey });
    }
  )
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
