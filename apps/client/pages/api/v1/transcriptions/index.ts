/**
 * POST /api/v1/transcriptions - transcribe one upload minted by POST /api/v1/transcriptions/uploads.
 * The public twin of POST /api/ai/transcribe; both call transcribeUpload. Synchronous, so long audio
 * on the AWS backend can outlive the request timeout (see the contract).
 */

import { createTranscriptionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { BadGatewayError } from '@server/utils/errors';
import { transcribeUpload } from '@server/transcribe/transcribe';
import { toPublicTranscribeError } from '@server/transcribe/toPublicTranscribeError';

const handler = nextRouteForContract(createTranscriptionContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    bucket: 'POST /api/v1/transcriptions',
  }),
}).post(async (req, res) => {
  const { text } = await transcribeUpload({
    userId: req.user.id,
    fileKey: req.validated.file_key,
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
