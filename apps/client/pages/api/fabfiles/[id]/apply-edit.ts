import { Permission, isImageServeable } from '@bike4mind/common';
import { FabFile, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { getFilesStorage } from '@server/utils/storage';
import { v4 as uuidv4 } from 'uuid';

const handler = baseApi()
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.update, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const { user } = req;
      const { id } = req.query;
      const { newContent } = req.body as {
        newContent: string;
      };

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Invalid file ID');
      }

      if (!newContent || typeof newContent !== 'string') {
        throw new BadRequestError('New content is required');
      }

      // Check content size - limit to 100KB
      const contentSize = Buffer.byteLength(newContent, 'utf8');
      if (contentSize > 100000) {
        throw new BadRequestError(`Content is too large (${Math.round(contentSize / 1024)}KB). Maximum size is 100KB.`);
      }

      // Check if user has access to this file
      const file = await withTransaction(async () => {
        return FabFile.findById(id).where({ userId: user.id });
      });

      if (!file) {
        throw new NotFoundError('File not found or access denied');
      }

      // A held/blocked uploaded image must not have its bytes read/overwritten.
      if (!isImageServeable(file)) {
        throw new BadRequestError('File is not available for editing');
      }

      try {
        // Create backup of current content
        const backupId = uuidv4();
        const backupPath = `files/${user.id}/backups/${backupId}_${file.fileName}`;

        // Get current content for backup
        if (!file.filePath) {
          throw new BadRequestError('File has no content');
        }

        // Use filePath directly as the S3 key
        const s3Key = file.filePath;

        const signedUrl = await getFilesStorage().getSignedUrl(s3Key, 'get', {
          expiresIn: 60,
        });
        const contentResponse = await fetch(signedUrl);
        const currentContent = await contentResponse.text();

        // Upload backup
        await getFilesStorage().upload(currentContent, backupPath, {
          ContentType: file.mimeType || 'text/plain',
          Metadata: {
            originalFileId: id,
            backupDate: new Date().toISOString(),
          },
        });

        // Apply the new content (using the same s3Key we extracted earlier)
        await getFilesStorage().upload(newContent, s3Key, {
          ContentType: file.mimeType || 'text/plain',
        });

        // Update file metadata
        await FabFile.updateOne(
          { _id: file._id },
          {
            $set: {
              updatedAt: new Date(),
              fileSize: Buffer.byteLength(newContent, 'utf8'),
            },
          }
        );

        return res.json({
          success: true,
          fileId: id,
          fileName: file.fileName,
          backupId,
          updatedAt: new Date(),
        });
      } catch (error) {
        console.error('Apply edit error:', error);
        throw new BadRequestError(error instanceof Error ? error.message : 'Failed to apply edit');
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
