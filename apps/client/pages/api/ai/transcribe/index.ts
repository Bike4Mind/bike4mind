import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { TRANSCRIBE_UPLOAD_PREFIX } from '@server/utils/transcribeConstants';
import { speechToTextService, creditService } from '@bike4mind/services';
import { Resource } from 'sst';
import { usdToCredits } from '@bike4mind/utils';
import { type ILogger } from '@bike4mind/observability';
import { CreditHolderType } from '@bike4mind/common';
import { userRepository, creditTransactionRepository, usageEventRepository } from '@bike4mind/database';
import { z } from 'zod';

const TranscribeRequestSchema = z.object({
  fileKey: z.string().min(1),
});

// File size is used as a proxy for duration since the actual duration is not
// available pre-transcription. PCM baseline (16-bit 16kHz mono) is multiplied
// by COMPRESSION_FACTOR as a conservative factor to account for compressed
// formats (MP3, OGG, WebM) that can be 10-20x smaller than PCM for the same
// duration. This intentionally over-charges slightly to avoid free usage.
const COMPRESSION_FACTOR = 5;
const PCM_BYTES_PER_MINUTE = 16000 * 2 * 60;
const AWS_USD_PER_MINUTE = 0.024;
const OPENAI_USD_PER_MINUTE = 0.006;

const s3Client = new S3Client();
const bucketName = Resource.appFilesBucket.name;

const handler = baseApi().post(
  asyncHandler<unknown, speechToTextService.TranscriptionResult>(async (req, res) => {
    const userId = req.user.id;

    const parsed = TranscribeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join('; ')}`);
    }
    const { fileKey } = parsed.data;

    // Ownership check: the init endpoint mints keys under transcribe-uploads/{userId}/.
    // Reject anything else to prevent users from transcribing arbitrary bucket objects.
    const expectedPrefix = `${TRANSCRIBE_UPLOAD_PREFIX}${userId}/`;
    if (!fileKey.startsWith(expectedPrefix)) {
      throw new BadRequestError('Invalid file key');
    }

    try {
      // HEAD the object to get S3-attested metadata. We never trust
      // client-supplied size or mime - S3's content-length-range condition
      // already enforced size at upload, and this re-reads what S3 accepted.
      let contentType: string;
      let contentLength: number;
      try {
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }));
        contentType = head.ContentType ?? '';
        contentLength = head.ContentLength ?? 0;
      } catch (err) {
        req.logger.warn('Transcribe HEAD failed', { fileKey, err });
        throw new BadRequestError('Uploaded file not found or expired');
      }

      if (
        !speechToTextService.ALLOWED_AUDIO_MIME_TYPES.includes(contentType as speechToTextService.AllowedAudioMimeType)
      ) {
        throw new BadRequestError(`Unsupported file type: ${contentType}`);
      }
      if (contentLength <= 0 || contentLength > speechToTextService.MAX_TRANSCRIBE_BYTES) {
        throw new BadRequestError('File size out of range');
      }

      const operationsModel = await OperationsModelService.getOperationsModel();
      const speechModelInfo = operationsModel.speechModelInfo;
      if (!speechModelInfo) {
        throw new BadRequestError('Speech model not configured. Please configure a speech model in admin settings.');
      }

      const user = await userRepository.findById(userId);
      if (!user) throw new BadRequestError('User not found');
      if ((user.currentCredits ?? 0) <= 0) {
        throw new BadRequestError('Insufficient credits for transcription');
      }

      const apiKey = await getEffectiveApiKeyByBackend(userId || 'system', speechModelInfo.backend);
      if (!apiKey && speechModelInfo.backend !== 'aws') {
        throw new BadRequestError(`API key not configured for ${speechModelInfo.backend} backend`);
      }
      // AWS doesn't need API keys - uses AWS credentials

      const speechToText = new speechToTextService.speechService(bucketName);

      let results: speechToTextService.TranscriptionResult;
      if (speechModelInfo.backend === 'openai') {
        results = await speechToText.transcribeOpenAIFromS3(fileKey, contentType, speechModelInfo, apiKey || '');
      } else if (speechModelInfo.backend === 'aws') {
        results = await speechToText.transcribeAWSFromS3(fileKey, contentType);
      } else {
        throw new BadRequestError(`Unsupported speech backend: ${speechModelInfo.backend}`);
      }

      await deductTranscriptionCredits({
        userId,
        backend: speechModelInfo.backend,
        contentLength,
        logger: req.logger,
      });

      return res.json(results);
    } finally {
      // Always clean up the transient upload, even on transcription failure.
      // Lifecycle rule on transcribe-uploads/ is the backstop for orphans.
      await deleteSilently(fileKey, req.logger);
    }
  })
);

interface DeductArgs {
  userId: string;
  backend: string;
  contentLength: number;
  logger: ILogger;
}

async function deductTranscriptionCredits({ userId, backend, contentLength, logger }: DeductArgs): Promise<void> {
  const durationMinutes = (contentLength * COMPRESSION_FACTOR) / PCM_BYTES_PER_MINUTE;
  const usdPerMinute = backend === 'aws' ? AWS_USD_PER_MINUTE : OPENAI_USD_PER_MINUTE;
  const costUsd = durationMinutes * usdPerMinute;
  const credits = usdToCredits(costUsd);
  if (credits <= 0) return;

  const sessionId = `transcribe-${userId}-${Date.now()}`;

  try {
    await creditService.subtractCredits(
      {
        type: 'speech_to_text_usage',
        ownerId: userId,
        ownerType: CreditHolderType.User,
        credits,
        model: backend,
        sessionId,
      },
      {
        db: { creditTransactions: creditTransactionRepository },
        creditHolderMethods: userRepository,
      }
    );

    // Dual-write usage event: analytics only, never billing.
    usageEventRepository
      .record({
        requestId: sessionId,
        userId,
        ownerId: userId,
        ownerType: CreditHolderType.User,
        sessionId,
        feature: 'transcription',
        provider: backend,
        model: backend,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        units: durationMinutes,
        costUsd,
        creditsCharged: credits,
        status: 'ok',
      })
      .catch(err => logger.warn('Failed to record usage event', { err }));
  } catch (err) {
    // Non-fatal: transcription succeeded; log billing miss for ops visibility.
    logger.error('Transcription credit deduction failed — billing may be missed', { userId, credits, err });
  }
}

async function deleteSilently(key: string, logger: ILogger): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (err) {
    logger.warn('Failed to delete transcribe upload', { key, err });
  }
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
