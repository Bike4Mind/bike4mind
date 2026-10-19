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
  holdTranscriptionCredits,
  estimateTranscriptionCost,
  MIN_TRANSCRIPTION_USD_PER_MINUTE,
  transcriptionUsdPerMinute,
} from '@server/utils/transcriptionCost';
import { speechToTextService } from '@bike4mind/services';
import { Resource } from 'sst';
import { type ILogger } from '@bike4mind/observability';
import { CreditHolderType, GatewayTimeoutError } from '@bike4mind/common';
import { usageEventRepository } from '@bike4mind/database';
import type { PreflightCreditHold } from '@server/utils/creditPreflight';
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
// The hosted web Lambda stops at 60s. Leave time to refund and clean up after cancelling the provider.
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 45_000;

const s3Client = new S3Client();
const bucketName = Resource.appFilesBucket.name;

// The transcription credit helpers throw BadRequestError only for a caller who cannot pay (or does not exist).
async function asInsufficientCredits<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
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
  await asInsufficientCredits(() =>
    assertTranscriptionCredits(userId, estimateTranscriptionCost(fileSize, MIN_TRANSCRIPTION_USD_PER_MINUTE).credits)
  );

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
  receivedAt,
  logger,
  mapProviderError,
}: {
  userId: string;
  fileKey: string;
  receivedAt: Date;
  logger: ILogger;
  mapProviderError?: (err: unknown) => unknown;
}): Promise<speechToTextService.TranscriptionResult> {
  // Ownership check: the init endpoint mints keys under transcribe-uploads/{userId}/.
  // Reject anything else to prevent users from transcribing arbitrary bucket objects.
  const expectedPrefix = `${TRANSCRIBE_UPLOAD_PREFIX}${userId}/`;
  if (!fileKey.startsWith(expectedPrefix)) {
    throw new TranscribeRequestError('invalid_key', 'Invalid file key');
  }

  const controller = new AbortController();
  const remainingMs = receivedAt.getTime() + TRANSCRIPTION_REQUEST_TIMEOUT_MS - Date.now();
  const expire = () =>
    controller.abort(
      new GatewayTimeoutError('Transcription timed out. Please try a shorter recording.', {
        errorCode: 'request_timeout',
      })
    );
  const deadline = setTimeout(expire, Math.max(remainingMs, 0));
  if (remainingMs <= 0) expire();
  const { signal } = controller;

  try {
    signal.throwIfAborted();
    // HEAD the object to get S3-attested metadata. We never trust
    // client-supplied size or mime - S3's content-length-range condition
    // already enforced size at upload, and this re-reads what S3 accepted.
    let contentType: string;
    let contentLength: number;
    try {
      const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: fileKey }), {
        abortSignal: signal,
      });
      contentType = head.ContentType ?? '';
      contentLength = head.ContentLength ?? 0;
    } catch (err) {
      signal.throwIfAborted();
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
    signal.throwIfAborted();
    const speechModelInfo = operationsModel.speechModelInfo;
    if (!speechModelInfo) {
      throw new TranscribeRequestError(
        'not_configured',
        'Speech model not configured. Please configure a speech model in admin settings.'
      );
    }

    const cost = estimateTranscriptionCost(contentLength, transcriptionUsdPerMinute(speechModelInfo.backend));

    const apiKey = await getEffectiveApiKeyByBackend(userId || 'system', speechModelInfo.backend);
    signal.throwIfAborted();
    if (!apiKey && speechModelInfo.backend !== 'aws') {
      throw new TranscribeRequestError(
        'not_configured',
        `API key not configured for ${speechModelInfo.backend} backend`
      );
    }
    // AWS doesn't need API keys - uses AWS credentials

    const speechToText = new speechToTextService.speechService(bucketName);

    // Held last, so no rejection above strands it; the actual cost is the same size-based figure.
    const hold = await asInsufficientCredits(() => holdTranscriptionCredits(userId, cost.credits, logger));
    let results: speechToTextService.TranscriptionResult;
    try {
      // A slow hold write can finish after the deadline. It must still enter the refund boundary.
      signal.throwIfAborted();
      if (speechModelInfo.backend === 'openai') {
        results = await speechToText.transcribeOpenAIFromS3(fileKey, contentType, speechModelInfo, apiKey || '', {
          abortSignal: signal,
        });
      } else if (speechModelInfo.backend === 'aws') {
        results = await speechToText.transcribeAWSFromS3(fileKey, contentType, { abortSignal: signal });
      } else {
        throw new TranscribeRequestError('not_configured', `Unsupported speech backend: ${speechModelInfo.backend}`);
      }
    } catch (err) {
      await hold.release();
      signal.throwIfAborted();
      if (err instanceof TranscribeRequestError || !mapProviderError) throw err;
      throw mapProviderError(err);
    }

    await deductTranscriptionCredits({
      hold,
      userId,
      backend: speechModelInfo.backend,
      contentLength,
      logger,
    });

    return results;
  } finally {
    clearTimeout(deadline);
    // Always clean up the transient upload, even on transcription failure.
    // Lifecycle rule on transcribe-uploads/ is the backstop for orphans.
    await deleteSilently(fileKey, logger);
  }
}

interface DeductArgs {
  hold: PreflightCreditHold;
  userId: string;
  backend: string;
  contentLength: number;
  logger: ILogger;
}

// Settles the hold; a billing failure is logged inside hold.settle, never surfaced (transcription succeeded).
async function deductTranscriptionCredits({ hold, userId, backend, contentLength, logger }: DeductArgs): Promise<void> {
  const {
    durationMinutes,
    costUsd,
    credits: cost,
  } = estimateTranscriptionCost(contentLength, transcriptionUsdPerMinute(backend));
  const sessionId = `transcribe-${userId}-${Date.now()}`;
  const credits = await hold.settle(cost, { type: 'speech_to_text_usage', model: backend, sessionId });
  if (credits <= 0) return;

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
}

async function deleteSilently(key: string, logger: ILogger): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }), {
      abortSignal: AbortSignal.timeout(2_000),
    });
  } catch (err) {
    logger.warn('Failed to delete transcribe upload', { key, err });
  }
}
