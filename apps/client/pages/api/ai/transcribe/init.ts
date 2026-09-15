import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { MIME_TO_EXTENSION, TRANSCRIBE_UPLOAD_PREFIX } from '@server/utils/transcribeConstants';
import { speechToTextService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const InitRequestSchema = z.object({
  mimeType: z.enum(speechToTextService.ALLOWED_AUDIO_MIME_TYPES),
  fileSize: z.number().int().positive().max(speechToTextService.MAX_TRANSCRIBE_BYTES),
});

interface InitResponse {
  url: string;
  fields: Record<string, string>;
  fileKey: string;
}

const PRESIGNED_POST_EXPIRY_SECONDS = 300; // 5 minutes

const s3Client = new S3Client();
const bucketName = Resource.appFilesBucket.name;

const handler = baseApi().post(
  asyncHandler<unknown, InitResponse>(async (req, res) => {
    const userId = req.user.id;

    const parsed = InitRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    }
    // fileSize is validated by the schema for fail-fast UX; the authoritative
    // size check is S3's content-length-range policy condition below.
    const { mimeType } = parsed.data;

    // Credit precheck so we don't issue an upload URL for users who can't pay.
    // The transcribe endpoint re-checks credits at consumption time - this is
    // a fail-fast UX guard, not the authoritative check.
    const user = await userRepository.findById(userId);
    if (!user) throw new BadRequestError('User not found');
    if ((user.currentCredits ?? 0) <= 0) {
      throw new BadRequestError('Insufficient credits for transcription');
    }

    const fileKey = `${TRANSCRIBE_UPLOAD_PREFIX}${userId}/${uuidv4()}.${MIME_TO_EXTENSION[mimeType]}`;

    const { url, fields } = await createPresignedPost(s3Client, {
      Bucket: bucketName,
      Key: fileKey,
      Conditions: [
        // S3 enforces these at upload time. content-length-range is the real
        // size guard the original Multer limit was supposed to provide.
        ['content-length-range', 1, speechToTextService.MAX_TRANSCRIBE_BYTES],
        ['eq', '$Content-Type', mimeType],
      ],
      Fields: {
        'Content-Type': mimeType,
      },
      Expires: PRESIGNED_POST_EXPIRY_SECONDS,
    });

    return res.json({ url, fields, fileKey });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
