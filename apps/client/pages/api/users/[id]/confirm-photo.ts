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
      const { name, $metadata } = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404) {
        throw new BadRequestError('Profile photo has not finished uploading');
      }
      throw err;
    }
    // The presign binds ContentType, but this is the step that promotes the bytes to photoUrl.
    if (uploaded.contentType?.split(';')[0].trim().toLowerCase() !== file.mimeType?.toLowerCase()) {
      throw new BadRequestError('Profile photo has an unexpected content type');
    }

    // Atomic swap returning the document as it was BEFORE the update, so concurrent confirms each
    // clean up exactly the photo they replaced instead of both cleaning up a stale read.
    const previous = await User.findOneAndUpdate({ _id: userId }, { photoUrl: file.path }, { new: false });
    if (!previous) throw new NotFoundError('User not found');
    const previousPath = previous.photoUrl;

    // A concurrent confirm may have replaced and deleted this file after the lookup above; put the
    // pre-image back (only if nothing newer landed) rather than leave photoUrl on a deleted key.
    if (!(await AppFile.exists({ _id: file.id }))) {
      await User.updateOne({ _id: userId, photoUrl: file.path }, { photoUrl: previousPath ?? null });
      throw new NotFoundError('Profile photo upload not found');
    }

    // Only delete the old photo when its AppFile belongs to the profile owner (the path param, not
    // the caller), so a poisoned photoUrl can never delete someone else's file.
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
