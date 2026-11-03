import { AppFileReservedTags, FileGeneratePresignedUrlRequestInput } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { User } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveBrowserAppFileUploadUrl } from '@server/utils/browserUploadUrl';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { FileEvents } from '@bike4mind/common';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

// First-party UI action, so API keys are not accepted (matches confirm-photo.ts).
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.query.id;
    if (!userId) throw new Error('User ID is required');

    // Only allow users to update their own photo
    if (userId !== req.user.id && !req.user.isAdmin) {
      throw new BadRequestError('You can only update your own profile photo');
    }

    const user = await User.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const data = FileGeneratePresignedUrlRequestInput.parse(req.body);

    // Profile photos accept image media types; confirm-photo checks the stored type before promotion.
    if (!data.mimeType.startsWith('image/')) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);
    const ext = mime.extension(data.mimeType);
    if (!ext) throw new BadRequestError(`Invalid mime type ${data.mimeType}`);

    const storage = new S3Storage(Resource.appFilesBucket.name);
    const fileKey = `profile-photos/${userId}/${uuidv4()}.${ext}`;

    // ACL not needed - bucket policy grants public read for profile-photos/* prefix
    // ContentType is bound so the PUT cannot carry a different type than the image mime validated above.
    const presignedUrl = await storage.getSignedUrl(fileKey, 'put', {
      expiresIn: 600,
      ContentType: data.mimeType,
      ContentLength: data.fileSize,
    });

    // photoUrl is deliberately NOT written here: the browser has not PUT the bytes yet, and CloudFront
    // 403s a missing key. confirm-photo.ts points the profile at this file once the object exists.
    // An upload that is never confirmed leaves this AppFile and its object orphaned; nothing sweeps them yet.
    const file = new AppFile({
      userId,
      name: `${user.name} profile photo`,
      size: data.fileSize,
      path: fileKey,
      mimeType: data.mimeType,
      status: 'pending',
      tags: [AppFileReservedTags.ProfilePhoto],
    });
    await file.save();
    const fileId = file.id;

    // Log event after the file record is saved
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

    // Self-host swaps the (browser-unreachable) MinIO presign for the same-origin upload proxy.
    return res.json({ url: resolveBrowserAppFileUploadUrl(fileId, presignedUrl), fileId, fileKey });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
