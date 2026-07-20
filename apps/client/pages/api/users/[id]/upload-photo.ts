import { AppFileReservedTags, FileGeneratePresignedUrlRequestInput } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { User, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { FileEvents } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.query.id;
    if (!userId) throw new Error('User ID is required');

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    // Only allow users to update their own photo
    if (userId !== req.user.id && !req.user.isAdmin) {
      throw new BadRequestError('You can only update your own profile photo');
    }

    const data = FileGeneratePresignedUrlRequestInput.parse(req.body);

    // Profile photos must be images (mirrors admin/upload-logo.ts). SVG stays allowed
    // as a valid image type, but the app-file proxy serves it inert via CSP.
    if (!data.mimeType.startsWith('image/')) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);
    const ext = mime.extension(data.mimeType);
    if (!ext) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);

    const storage = new S3Storage(Resource.appFilesBucket.name);
    const fileKey = `profile-photos/${userId}/${uuidv4()}.${ext}`;

    // Get presigned URL before transaction since it's not a DB operation
    // ACL not needed - bucket policy grants public read for profile-photos/* prefix
    const presignedUrl = await storage.getSignedUrl(fileKey, 'put', { expiresIn: 600 });

    // Handle DB operations in transaction
    const { fileId } = await withTransaction(async session => {
      if (user.photoUrl) {
        await storage.delete(user.photoUrl);
        await AppFile.findOneAndDelete({ path: user.photoUrl }).session(session);
        await User.updateOne({ _id: userId }, { $unset: { photoUrl: 1 } }).session(session);
      }

      const file = new AppFile({
        userId: req.user.id,
        name: `${user.name} profile photo`,
        size: data.fileSize,
        path: fileKey,
        mimeType: data.mimeType,
        status: 'pending',
        tags: [AppFileReservedTags.ProfilePhoto],
      });

      await Promise.all([
        file.save({ session }),
        User.updateOne({ _id: userId }, { photoUrl: fileKey }).session(session),
      ]);

      return { fileId: file.id };
    });

    // Log event after transaction is complete
    await logEvent(
      {
        userId,
        type: FileEvents.FILE_UPLOADED,
        metadata: {
          fileId,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
        },
      },
      { ability: req.ability }
    );

    return res.json({ url: presignedUrl, fileId, fileKey });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
