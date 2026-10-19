/**
 * POST /api/v1/transcriptions - transcribe one upload minted by POST /api/v1/transcriptions/uploads.
 * The public twin of POST /api/ai/transcribe; both call transcribeUpload with the request-arrival
 * timestamp so provider cancellation leaves time to release the hold before the server deadline.
 */

import { createTranscriptionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { BadGatewayError } from '@server/utils/errors';
import { transcribeUpload } from '@server/transcribe/transcribe';
import { toPublicTranscribeError } from '@server/transcribe/toPublicTranscribeError';

const handler = nextRouteForContract(createTranscriptionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/transcriptions'),
}).post(async (req, res) => {
  const { text } = await transcribeUpload({
    userId: req.user.id,
    fileKey: req.validated.file_key,
    receivedAt: req.receivedAt,
    logger: req.logger,
    mapProviderError: err => {
      req.logger.error('Transcription provider failed', { err });
      return new BadGatewayError('The speech provider failed to transcribe the audio');
    },
  }).catch(err => {
    throw toPublicTranscribeError(err);
  });

  return res.json({ text });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
