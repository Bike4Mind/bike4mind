import { Permission, isImageServeable, fabFileResponseSchema, type IFabFileDocument } from '@bike4mind/common';
import { FabFile, fabFileRepository } from '@bike4mind/database';
import { fileUrlSigningDate, FILE_URL_TTL_SECONDS, signedUrlExpiresAt } from '@bike4mind/utils';
import { storageReadOverrides } from '@bike4mind/utils/contentDisposition';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { respond } from '@server/utils/respond';
import { BadRequestError, InternalServerError } from '@bike4mind/server-utils/utils/errors';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { FILES_WRITE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import { copyGeneratedImageToFiles } from '@server/files/copyGeneratedImage';
import { z } from 'zod';

const copyGeneratedImageSchema = z.object({
  imageS3Key: z.string().describe('The S3 key of the image in the generatedImagesBucket'),
  fileName: z.string().optional().describe('Optional custom filename for the saved image'),
});

type CopyGeneratedImageInput = z.infer<typeof copyGeneratedImageSchema>;

// `created` tells the caller whether this call made the file, so it never deletes the caller's earlier copy.
const copiedImageResponseSchema = fabFileResponseSchema.extend({ created: z.boolean() });

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES })
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, CopyGeneratedImageInput>(async (req, res) => {
      const { imageS3Key, fileName } = copyGeneratedImageSchema.parse(req.body);
      const { fileId, created } = await copyGeneratedImageToFiles(req, { imageS3Key, fileName });
      const result = await fabFileRepository.findById(fileId);
      if (!result) throw new InternalServerError('Failed to save the image to your files');

      // The generated image is already moderated, but the new FabFile row starts 'pending' until
      // the async objectCreated scan clears it - only return a working URL once serveable;
      // otherwise return the record with no fileUrl so the client can show a placeholder.
      const responseFile =
        typeof (result as { toJSON?: unknown }).toJSON === 'function'
          ? (result as unknown as { toJSON: () => IFabFileDocument }).toJSON()
          : result;
      if (responseFile.filePath && isImageServeable(responseFile)) {
        const presignedUrl = await getFilesStorage().getSignedUrl(responseFile.filePath, 'get', {
          expiresIn: FILE_URL_TTL_SECONDS,
          audience: 'browser',
          signingDate: fileUrlSigningDate(),
          ...storageReadOverrides({
            mimeType: responseFile.mimeType,
            fileName: responseFile.fileName,
            key: responseFile.filePath,
          }),
        });

        return respond(res, copiedImageResponseSchema, {
          ...responseFile,
          fileUrl: presignedUrl,
          fileUrlExpireAt: signedUrlExpiresAt(presignedUrl, FILE_URL_TTL_SECONDS),
          created,
        });
      }

      return respond(res, copiedImageResponseSchema, { ...responseFile, created });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
