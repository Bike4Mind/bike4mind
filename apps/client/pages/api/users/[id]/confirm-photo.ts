import { AppFileReservedTags } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { User } from '@bike4mind/database';
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

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');

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
    try {
      await storage.getMetadata(file.path);
    } catch {
      throw new BadRequestError('Profile photo has not finished uploading');
    }

    const previousPath = user.photoUrl;
    await User.updateOne({ _id: userId }, { photoUrl: file.path });

    // Defense-in-depth: only delete the underlying S3 object + AppFile when the AppFile at the old
    // key belongs to the profile owner. A photoUrl poisoned before the self-service update stopped
    // accepting it (or by any other writer) must never delete a file that is not this profile's
    // photo. The owner is the path param, not the caller: an admin may upload on another user's behalf.
    if (previousPath && previousPath !== file.path) {
      const existing = await AppFile.findOne({ path: previousPath });
      if (existing && existing.userId?.toString() === userId) {
        // Best effort: the new photo is already live, so a failed cleanup must not fail the request.
        await Promise.allSettled([storage.delete(previousPath), AppFile.findOneAndDelete({ path: previousPath })]);
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
