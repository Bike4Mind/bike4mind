import type {
  AudioJobOutput,
  GeneratedAssetSaveSkippedReason,
  IGenerationJobDocument,
  StorageLimitErrorInfo,
} from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The provider's HTTP status on a failed job, when the provider answered with one (see toAudioProviderResult). */
export const providerStatusOf = (job: IGenerationJobDocument): number | undefined =>
  isRecord(job.rawProviderError) && typeof job.rawProviderError.status === 'number'
    ? job.rawProviderError.status
    : undefined;

/**
 * A job that kept getting 429s: the engine fails it once its retries run out, keeping only the step's reason
 * (`<vendor>_rate_limited`, from toAudioProviderResult) and no raw payload.
 */
export const isRateLimitedFailure = (job: IGenerationJobDocument): boolean =>
  providerStatusOf(job) === 429 || (job.error?.message.endsWith('_rate_limited') ?? false);
