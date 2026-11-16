import {
  DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
  TooManyRequestsError,
  isGenerationJobOfKind,
  type AudioJobOutput,
  type GeneratedAssetSaveSkippedReason,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type StorageLimitErrorInfo,
} from '@bike4mind/common';
import { fabFileRepository, generationJobRepository } from '@bike4mind/database';
import type { SaveGeneratedAssetResult } from '@bike4mind/services';
import type { CreateAudioJobResult } from '@bike4mind/services/audioJobs';

/**
 * Shared by the synchronous audio routes (/api/ai/tts, /api/ai/sound-effects), which create a speech or
 * sound-effect job, step it in-process with runAudioJobInline and answer with the clip.
 */

// Under the 60s serving cap, leaving room to read the clip back and deliver it.
export const AUDIO_JOB_INLINE_TIMEOUT_MS = 55_000;

type SaveSkipped = Extract<SaveGeneratedAssetResult, { saved: false }>;

// Mirrors saveGeneratedAsset's skipReasonFor, so a full quota reads the same as it did when the route saved itself.
const quotaSkipReason = (storage: StorageLimitErrorInfo): GeneratedAssetSaveSkippedReason =>
  storage.errorCode === 'file_too_large' ? 'file_too_large' : 'storage_limit';

/**
 * Creates the job, and when the Files quota cannot take the clip, creates it again without the saved copy: these
 * routes never refused for a full quota, they returned the audio and reported the save as skipped.
 */
export async function createAudioJobKeepingAudioOnFullQuota<J>(
  create: (saveToFiles: boolean) => Promise<CreateAudioJobResult<J>>,
  saveToFiles: boolean
): Promise<{ result: CreateAudioJobResult<J>; saveToFiles: boolean; quotaSkip?: SaveSkipped }> {
  const first = await create(saveToFiles);
  if (first.ok || first.code !== 'storage_quota_exceeded') return { result: first, saveToFiles };
  return {
    result: await create(false),
    saveToFiles: false,
    quotaSkip: { saved: false, reason: quotaSkipReason(first.storage) },
  };
}

/**
 * The save outcome of a succeeded job, in the shape deliverGeneratedAudio reports. Undefined when no copy was asked
 * for; a clip kept in the generated bucket despite asking means the Files write failed and fell back.
 */
export async function savedCopyOf(
  output: AudioJobOutput | undefined,
  saveToFiles: boolean
): Promise<SaveGeneratedAssetResult | undefined> {
  if (!saveToFiles) return undefined;
  if (output?.location !== 'files' || !output.fileId) return { saved: false, reason: 'error' };
  const file = await fabFileRepository.findById(output.fileId);
  if (!file) return { saved: false, reason: 'error' };
  return {
    saved: true,
    fileId: output.fileId,
    s3Key: output.s3Key,
    fileName: file.fileName,
    ...(file.fileUrl && { fileUrl: file.fileUrl }),
  };
}

/**
 * The job as it stands after the inline wait gave up on it, for the 202 the routes answer with: it carries on in the
 * worker and settles only if the clip is made. Null when it is gone (or not of `kind`), which stays a 502.
 */
export async function findOutlastingAudioJob<K extends 'speech' | 'sound_effect'>(
  jobId: string,
  kind: K
): Promise<IGenerationJobDocumentOf<K> | null> {
  const job = await generationJobRepository.findById(jobId);
  return job && isGenerationJobOfKind(job, kind) ? job : null;
}

/** The provider's HTTP status on a failed job, when the provider answered with one (see the audio job handlers). */
export const providerStatusOf = (job: IGenerationJobDocument): number | undefined => job.error?.providerStatus;

/**
 * A job the provider rate limited or that found no free capacity slot. The handlers fail it at once instead of
 * retrying, so the caller is told to come back rather than the job billing after the inline wait gave up.
 */
export const isRateLimitedFailure = (job: IGenerationJobDocument): boolean =>
  job.state === 'failed' && providerStatusOf(job) === 429;

// For a rate-limited failure recorded without a hint of its own.
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** The Retry-After, in seconds, to send with a rate-limited failure. */
export const retryAfterSecondsOf = (job: IGenerationJobDocument): number =>
  job.error?.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;

/** The free-tier daily cap refusal, exactly as the credit reservation threw it before these routes ran as jobs. */
export const dailyLimitError = (refusal: { message: string; retryAfterSeconds: number }) =>
  new TooManyRequestsError(refusal.message, {
    errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
    retryAfter: refusal.retryAfterSeconds,
  });
