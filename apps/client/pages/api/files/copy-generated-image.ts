import {
  FileEvents,
  KnowledgeType,
  Permission,
  SupportedFabFileMimeTypes,
  extensionFromMimeType,
  isImageServeable,
} from '@bike4mind/common';
import { FabFile, User, withTransaction, adminSettingsRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { z } from 'zod';

const copyGeneratedImageSchema = z.object({
  imageS3Key: z.string().describe('The S3 key of the image in the generatedImagesBucket'),
  fileName: z.string().optional().describe('Optional custom filename for the saved image'),
});

type CopyGeneratedImageInput = z.infer<typeof copyGeneratedImageSchema>;

const handler = baseApi()
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, CopyGeneratedImageInput>(async (req, res) => {
      const { user } = req;
      const { imageS3Key, fileName } = copyGeneratedImageSchema.parse(req.body);

      const imageBuffer = await getGeneratedImageStorage().download(imageS3Key);

      const metadata = await getGeneratedImageStorage().getMetadata(imageS3Key);
      const contentType = metadata.contentType || SupportedFabFileMimeTypes.PNG;

      // Derive the extension via the shared reverse lookup so structured types (e.g. Excel's
      // spreadsheetml) map to ".xlsx" instead of a bogus ".sheet".
      const extension = extensionFromMimeType(contentType) || 'png';
      const finalFileName = fileName || `image_${Date.now()}.${extension}`;

      const result = await withTransaction(async () => {
        return fabFilesService.createFabFile(
          user.id,
          {
            type: KnowledgeType.FILE,
            fileName: finalFileName,
            mimeType: contentType,
            fileSize: imageBuffer.length,
            content: imageBuffer, // Pass the buffer as content to trigger upload
          },
          {
            db: {
              adminSettings: adminSettingsRepository,
              fabFiles: FabFile,
              users: User,
            },
            storage: {
              upload: async (filepath, _content, option) => {
                try {
                  console.log(`[copy-generated-image] Uploading to S3: ${filepath}, size: ${imageBuffer.length}`);
                  // S3Storage.upload signature: (content, destination, options)
                  await getFilesStorage().upload(imageBuffer, filepath, {
                    ContentType: option?.ContentType || contentType,
                  });
                  console.log(`[copy-generated-image] Upload successful: ${filepath}`);
                  return filepath;
                } catch (error) {
                  console.error('[copy-generated-image] Upload failed:', error);
                  throw error;
                }
              },
              generateSignedUrl: (filepath: string, expireInSeconds: number) =>
                getFilesStorage().getSignedUrl(filepath, 'put', {
                  expiresIn: expireInSeconds,
                }),
            },
          }
        );
      });

      await logEvent(
        { userId: user.id, type: FileEvents.CREATE_FILE, metadata: { fileId: result.id } },
        { ability: req.ability }
      );

      // The generated image is already moderated, but the new FabFile row starts 'pending' until
      // the async objectCreated scan clears it - only return a working URL once serveable;
      // otherwise return the record with no fileUrl so the client can show a placeholder.
      if (result.filePath && isImageServeable(result)) {
        const presignedUrl = await getFilesStorage().getSignedUrl(result.filePath, 'get', {
          expiresIn: 3600,
        });

        return res.json({
          ...result,
          fileUrl: presignedUrl,
          fileUrlExpireAt: new Date(Date.now() + 3600 * 1000),
        });
      }

      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
