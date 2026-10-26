import { AppFileReservedTags } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { User, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';
import { z } from 'zod';

const ConfirmPhotoInput = z.object({ fileId: z.string().min(1) });

// First-party UI action, so API keys are not accepted.
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.query.id;
    if (!userId) throw new Error('User ID is required');

    if (userId !== req.user.id && !req.user.isAdmin) {
      throw new BadRequestError('You can only update your own profile photo');
    }

    const { fileId } = ConfirmPhotoInput.parse(req.body);

    // The file must be a profile photo that upload-photo minted for this profile owner, so a caller
    // cannot point photoUrl at an arbitrary key or another user's file.
    const file = isValidObjectId(fileId) ? await AppFile.findById(fileId) : null;
    if (
      !file ||
      file.userId?.toString() !== userId ||
      !file.tags?.includes(AppFileReservedTags.ProfilePhoto) ||
      !file.path.startsWith(`profile-photos/${userId}/`)
    ) {
      throw new NotFoundError('Profile photo upload not found');
    }

    const storage = new S3Storage(Resource.appFilesBucket.name);
    let uploaded: Awaited<ReturnType<typeof storage.getMetadata>>;
    try {
      uploaded = await storage.getMetadata(file.path);
    } catch (err) {
      const storageError = z
        .object({
          name: z.string().optional(),
          $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
        })
        .safeParse(err);
      if (
        storageError.success &&
        (storageError.data.name === 'NotFound' ||
          storageError.data.name === 'NoSuchKey' ||
          storageError.data.$metadata?.httpStatusCode === 404)
      ) {
        throw new BadRequestError('Profile photo has not finished uploading');
      }
      throw err;
    }
    // The presign binds ContentType, but this is the step that promotes the bytes to photoUrl.
    if (uploaded.contentType?.split(';')[0].trim().toLowerCase() !== file.mimeType?.toLowerCase()) {
      throw new BadRequestError('Profile photo has an unexpected content type');
    }

    // Retire the old record with the pointer swap, so a racing confirm cannot revive a key
    // scheduled for deletion. A write conflict retries the candidate lookup as well as the swap.
    const retiredPath = await withTransaction(async session => {
      const candidate = await AppFile.findOne(
        { _id: fileId, userId, path: file.path, mimeType: file.mimeType, tags: AppFileReservedTags.ProfilePhoto },
        null,
        { session }
      );
      if (!candidate) throw new NotFoundError('Profile photo upload not found');

      const previous = await User.findOneAndUpdate(
        { _id: userId },
        { photoUrl: candidate.path },
        { new: false, session }
      );
      if (!previous) throw new NotFoundError('User not found');
      const previousPath = previous.photoUrl;
      if (!previousPath || previousPath === candidate.path || !previousPath.startsWith(`profile-photos/${userId}/`)) {
        return null;
      }

      const retired = await AppFile.findOneAndDelete(
        { path: previousPath, userId, tags: AppFileReservedTags.ProfilePhoto },
        { session }
      );
      return retired?.path ?? null;
    });

    if (retiredPath) {
      try {
        await storage.delete(retiredPath);
      } catch (error) {
        console.warn('Failed to delete retired profile photo', error);
      }
    }

    return res.json({ fileId, fileKey: file.path });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
