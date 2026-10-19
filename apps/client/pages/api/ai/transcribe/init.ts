import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { createTranscribeUpload } from '@server/transcribe/transcribe';
import { speechToTextService } from '@bike4mind/services';
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

const handler = baseApi().post(
  asyncHandler<unknown, InitResponse>(async (req, res) => {
    const parsed = InitRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    }
    // fileSize is validated by the schema for fail-fast UX; the authoritative
    // size check is S3's content-length-range policy condition.
    const { mimeType, fileSize } = parsed.data;
    return res.json(await createTranscribeUpload({ userId: req.user.id, mimeType, fileSize }));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
