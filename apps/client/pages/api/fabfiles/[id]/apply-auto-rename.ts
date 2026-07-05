import { Permission } from '@bike4mind/common';
import { FabFile, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

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
      const { newFileName } = req.body as { newFileName: string };

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Invalid file ID');
      }

      if (!newFileName || typeof newFileName !== 'string') {
        throw new BadRequestError('New filename is required');
      }

      // Check if user has access to this file
      const file = await withTransaction(async () => {
        return FabFile.findById(id).where({ userId: user.id });
      });

      if (!file) {
        throw new NotFoundError('File not found or access denied');
      }

      // Check for duplicate filename one more time (in case another file was created/renamed in the meantime)
      const duplicateFile = await FabFile.findOne({
        userId: user.id,
        fileName: newFileName,
        _id: { $ne: file._id },
      }).lean();

      if (duplicateFile) {
        throw new BadRequestError(`A file with the name "${newFileName}" already exists. Please try again.`);
      }

      console.log(`[Apply Auto-Rename API] Renaming file ${file.fileName} to ${newFileName}`);

      // Update the file with the new name
      await FabFile.updateOne(
        { _id: file._id },
        {
          $set: {
            fileName: newFileName,
            updatedAt: new Date(),
          },
        }
      );

      // Fetch the updated file
      const updatedFile = await FabFile.findById(id).lean();

      return res.json(updatedFile);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
