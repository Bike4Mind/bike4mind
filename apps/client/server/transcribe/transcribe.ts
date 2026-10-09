/**
 * Upload-then-transcribe flow shared by the SPA-internal /api/ai/transcribe routes and the public
 * /api/v1/transcriptions routes, so both doors enforce the same ownership, size, type and credit
 * gates. Every rejection is a TranscribeRequestError: a 400 as thrown (what the legacy routes
 * answer), with a `kind` the v1 routes map onto the CONVENTIONS.md status table.
 */
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { BadRequestError } from '@server/utils/errors';
import { MIME_TO_EXTENSION, TRANSCRIBE_UPLOAD_PREFIX } from '@server/utils/transcribeConstants';
import {
  assertTranscriptionCredits,
  estimateTranscriptionCost,
  MIN_TRANSCRIPTION_USD_PER_MINUTE,
  transcriptionUsdPerMinute,
} from '@server/utils/transcriptionCost';
import { speechToTextService, creditService } from '@bike4mind/services';
import { Resource } from 'sst';
import { type ILogger } from '@bike4mind/observability';
import { CreditHolderType } from '@bike4mind/common';
import { userRepository, creditTransactionRepository, usageEventRepository } from '@bike4mind/database';
import { v4 as uuidv4 } from 'uuid';

export type TranscribeRejection =
  'insufficient_credits' | 'invalid_key' | 'not_found' | 'unsupported_type' | 'size_out_of_range' | 'not_configured';

export class TranscribeRequestError extends BadRequestError {
  constructor(
    public kind: TranscribeRejection,
    message: string
  ) {
    super(message);
  }
}

export const PRESIGNED_POST_EXPIRY_SECONDS = 300; // 5 minutes

const s3Client = new S3Client();
const bucketName = Resource.appFilesBucket.name;

// assertTranscriptionCredits throws BadRequestError only for a caller who cannot pay (or does not exist).
async function assertCanPay(userId: string, estimatedCredits: number): Promise<void> {
  try {
    await assertTranscriptionCredits(userId, estimatedCredits);
  } catch (err) {
    if (err instanceof BadRequestError) throw new TranscribeRequestError('insufficient_credits', err.message);
    throw err;
  }
}

/** Mints a presigned POST for one audio upload under the caller's transcribe prefix. */
export async function createTranscribeUpload({
  userId,
  mimeType,
  fileSize,
}: {
  userId: string;
  mimeType: speechToTextService.AllowedAudioMimeType;
  fileSize: number;
}): Promise<{ url: string; fields: Record<string, string>; fileKey: string }> {
  // Credit precheck so we don't issue an upload URL for users who can't pay.
  // The transcribe endpoint re-checks credits at consumption time against the
  // S3-attested size and the resolved backend - this is a fail-fast UX guard
  // on the client-declared size, priced at the cheapest backend so it never
  // refuses what that check admits.
  await assertCanPay(userId, estimateTranscriptionCost(fileSize, MIN_TRANSCRIPTION_USD_PER_MINUTE).credits);

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

  return { url, fields, fileKey };
}

/**
 * Transcribes one upload minted by createTranscribeUpload, bills it by size, and deletes it
 * whatever the outcome. `mapProviderError` rewraps a failure of the provider call alone; without
 * it that failure is rethrown as is.
 */
export async function transcribeUpload({
  userId,
  fileKey,
  logger,
  mapProviderError,
}: {
  userId: string;
  fileKey: string;
  logger: ILogger;
  mapProviderError?: (err: unknown) => unknown;
}): Promise<speechToTextService.TranscriptionResult> {
  // Ownership check: the init endpoint mints keys under transcribe-uploads/{userId}/.
  // Reject anything else to prevent users from transcribing arbitrary bucket objects.
  const expectedPrefix = `${TRANSCRIBE_UPLOAD_PREFIX}${userId}/`;
  if (!fileKey.startsWith(expectedPrefix)) {
    throw new TranscribeRequestError('invalid_key', 'Invalid file key');
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
      logger.warn('Transcribe HEAD failed', { fileKey, err });
      throw new TranscribeRequestError('not_found', 'Uploaded file not found or expired');
    }

    if (
      !speechToTextService.ALLOWED_AUDIO_MIME_TYPES.includes(contentType as speechToTextService.AllowedAudioMimeType)
    ) {
      throw new TranscribeRequestError('unsupported_type', `Unsupported file type: ${contentType}`);
    }
    if (contentLength <= 0 || contentLength > speechToTextService.MAX_TRANSCRIBE_BYTES) {
      throw new TranscribeRequestError('size_out_of_range', 'File size out of range');
    }

    const operationsModel = await OperationsModelService.getOperationsModel();
    const speechModelInfo = operationsModel.speechModelInfo;
    if (!speechModelInfo) {
      throw new TranscribeRequestError(
        'not_configured',
        'Speech model not configured. Please configure a speech model in admin settings.'
      );
    }

    const cost = estimateTranscriptionCost(contentLength, transcriptionUsdPerMinute(speechModelInfo.backend));
    await assertCanPay(userId, cost.credits);

    const apiKey = await getEffectiveApiKeyByBackend(userId || 'system', speechModelInfo.backend);
    if (!apiKey && speechModelInfo.backend !== 'aws') {
      throw new TranscribeRequestError(
        'not_configured',
        `API key not configured for ${speechModelInfo.backend} backend`
      );
    }
    // AWS doesn't need API keys - uses AWS credentials

    const speechToText = new speechToTextService.speechService(bucketName);

    let results: speechToTextService.TranscriptionResult;
    try {
      if (speechModelInfo.backend === 'openai') {
        results = await speechToText.transcribeOpenAIFromS3(fileKey, contentType, speechModelInfo, apiKey || '');
      } else if (speechModelInfo.backend === 'aws') {
        results = await speechToText.transcribeAWSFromS3(fileKey, contentType);
      } else {
        throw new TranscribeRequestError('not_configured', `Unsupported speech backend: ${speechModelInfo.backend}`);
      }
    } catch (err) {
      if (err instanceof TranscribeRequestError || !mapProviderError) throw err;
      throw mapProviderError(err);
    }

    await deductTranscriptionCredits({
      userId,
      backend: speechModelInfo.backend,
      contentLength,
      logger,
    });

    return results;
  } finally {
    // Always clean up the transient upload, even on transcription failure.
    // Lifecycle rule on transcribe-uploads/ is the backstop for orphans.
    await deleteSilently(fileKey, logger);
  }
}

interface DeductArgs {
  userId: string;
  backend: string;
  contentLength: number;
  logger: ILogger;
}

async function deductTranscriptionCredits({ userId, backend, contentLength, logger }: DeductArgs): Promise<void> {
  const { durationMinutes, costUsd, credits } = estimateTranscriptionCost(
    contentLength,
    transcriptionUsdPerMinute(backend)
  );
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
    logger.error('Transcription credit deduction failed - billing may be missed', { userId, credits, err });
  }
}

async function deleteSilently(key: string, logger: ILogger): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (err) {
    logger.warn('Failed to delete transcribe upload', { key, err });
  }
}
