import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { transcribeUpload } from '@server/transcribe/transcribe';
import { speechToTextService } from '@bike4mind/services';
import { z } from 'zod';

const TranscribeRequestSchema = z.object({
  fileKey: z.string().min(1),
});

const handler = baseApi().post(
  asyncHandler<unknown, speechToTextService.TranscriptionResult>(async (req, res) => {
    const parsed = TranscribeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    }
    return res.json(await transcribeUpload({ userId: req.user.id, fileKey: parsed.data.fileKey, logger: req.logger }));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
