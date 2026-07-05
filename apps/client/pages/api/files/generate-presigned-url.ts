import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  FileGeneratePresignedUrlRequestInput,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
  KnowledgeType,
} from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { adminSettingsRepository, dataLakeRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { getSettingsMap, resolveSupportedMimeType } from '@bike4mind/utils';
import { createFabFile } from '@server/managers/fabFileManager';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { FileEvents } from '@bike4mind/common';
import { checkStorageLimit } from '@bike4mind/utils';
import { Resource } from 'sst';

const s3Client = new S3Client();

const handler = baseApi().post(
  asyncHandler<unknown, FileGeneratePresignedUrlResponseType, FileGeneratePresignedUrlRequestInputType>(
    async (req, res) => {
      const expires = 600; // URL expires in 10 minutes

      const userId = req.user.id;
      const data = FileGeneratePresignedUrlRequestInput.parse(req.body);

      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      let maxFileSize: number = 20 * 1024 * 1024; // Default to 20MB
      if (settings.MaxFileSize) {
        try {
          // Convert the MB setting to bytes
          maxFileSize = parseInt(settings.MaxFileSize, 10) * 1024 * 1024;
          console.log(`MaxFileSize set to ${maxFileSize} bytes`);
        } catch (err) {
          console.log('Error parsing MaxFileSize setting', err);
        }
      }

      if (!data.fileSize) throw new BadRequestError('No file size provided');
      if (data.fileSize >= maxFileSize) throw new BadRequestError('File size exceeds maximum file size');

      if (!checkStorageLimit(req.user, data.fileSize)) throw new BadRequestError('File size exceeds storage limit');

      console.log('==============');
      console.log('Generating presigned URL for file', data.fileName);
      console.log('File size', data.fileSize);
      console.log('Mime type', data.mimeType);
      console.log('==============');

      // Applying a lake's `datalake:*` meta-tag is a WRITE into that lake - gate it so this
      // presign door can't be used to inject files into a lake the caller only reads.
      await dataLakeService.assertCanWriteDataLakeTags(
        { userId, isAdmin: !!req.user.isAdmin },
        (data.tags ?? []).map(t => t.name),
        { db: { dataLakes: dataLakeRepository } }
      );

      // Reject unsupported/binary types (e.g. .exe) - the chunker can't
      // vectorize them, and the prior `mime.extension()` guard let generic
      // binaries (application/octet-stream mapped to "bin") slip through.
      const { mimeType, supported } = resolveSupportedMimeType(data.fileName, data.mimeType);
      if (!supported)
        throw new BadRequestError(
          `File "${data.fileName}" has an unsupported file type${
            data.mimeType ? ` (${data.mimeType})` : ''
          }. Supported types include documents, spreadsheets, images, code, and text files.`
        );

      const ext = mime.extension(mimeType);
      const fileKey = `${uuidv4()}${ext ? `.${ext}` : ''}`;

      const command = new PutObjectCommand({
        Bucket: Resource.fabFileBucket.name,
        Key: fileKey,
      });

      // Create File metadata, status will be set to `pending` by default
      const file = await createFabFile(
        {
          userId,
          filePath: fileKey,
          fileSize: data.fileSize,
          fileName: data.fileName,
          mimeType: mimeType,
          type: KnowledgeType.FILE,
          ...(data.contentHash && { contentHash: data.contentHash }),
          ...(data.batchId && { batchId: data.batchId }),
          ...(data.relativePath && { relativePath: data.relativePath }),
          ...(data.tags && { tags: data.tags }),
        },
        req.ability!
      );

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: expires,
      });

      await logEvent(
        {
          userId,
          type: FileEvents.GENERATE_FILE_PRESIGNED_URL,
          metadata: { id: file.id, url: presignedUrl, expiry: expires },
        },
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
