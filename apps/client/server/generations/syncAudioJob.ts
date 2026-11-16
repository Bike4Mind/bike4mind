import {
  DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
  TERMINAL_GENERATION_JOB_STATES,
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
import type { CancelRequestOutcome, RunJobInlineOptions } from '@bike4mind/services/generationJobs';
import { requestAudioJobCancel, runAudioJobInline } from '@bike4mind/server-utils/generationJobs/audioJobWiring';

/**
 * Shared by the synchronous audio routes (/api/ai/tts, /api/ai/sound-effects), which create a speech or
 * sound-effect job, step it in-process with runAudioJobInline and answer with the clip.
 */

// The window, from the request's arrival (req.receivedAt), that the web Lambda (60s timeout) and CloudFront's 60s
// origin read leave: 2s short of both, for the request and response in transit.
const AUDIO_JOB_RESPONSE_BUDGET_MS = 58_000;
// Kept back from the wait for reading the clip back from S3, looking up its saved file and writing the response.
const AUDIO_JOB_READ_BACK_RESERVE_MS = 3_000;
// Kept back from each step for what runs after its budget: the bucket fallback of a Files save the step's abort cut
// short (FALLBACK_SAVE_BUDGET_MS, 10s), then the commit and the credit settlement. So a step ends by 44s from
// arrival, and inlineMinStepMs (40s) starts one only while the request is at most ~4s old.
const AUDIO_JOB_STEP_RESERVE_MS = 11_000;

/** runAudioJobInline's options for a request that arrived at `receivedAt`, waiting at most for what it has left. */
export function audioJobInlineOptions(receivedAt: Date | undefined, minStepMs: number, now = Date.now()) {
  const arrivedAt = receivedAt?.getTime() ?? now;
  return {
    timeoutMs: arrivedAt + AUDIO_JOB_RESPONSE_BUDGET_MS - AUDIO_JOB_READ_BACK_RESERVE_MS - now,
    minStepMs,
    stepReserveMs: AUDIO_JOB_STEP_RESERVE_MS,
  } satisfies RunJobInlineOptions;
}

type AudioJobKind = 'speech' | 'sound_effect';

/**
 * How the inline wait for an audio job ended. `ended`: terminal, to deliver or map to an error. `outlasting`: still
 * going and saving to Files, answered 202. `unretrievable`: still going but not saving to Files, so nothing could
 * pick the clip up later; a cancel was requested (refused once its provider call has started). `gone`: no such job.
 */
export type InlineAudioJobOutcome<K extends AudioJobKind> =
  | { status: 'ended'; job: IGenerationJobDocumentOf<K> }
  | { status: 'outlasting'; job: IGenerationJobDocumentOf<K> }
  | { status: 'unretrievable'; job: IGenerationJobDocumentOf<K>; cancel: CancelRequestOutcome['status'] }
  | { status: 'gone' };

const isTerminal = (job: IGenerationJobDocument) => TERMINAL_GENERATION_JOB_STATES.includes(job.state);

const ofKind = <K extends AudioJobKind>(
  job: IGenerationJobDocument | null,
  kind: K
): IGenerationJobDocumentOf<K> | null => (job && isGenerationJobOfKind(job, kind) ? job : null);

/**
 * Steps the job inline within what the request has left, then decides what the route answers. A job the wait gave
 * up on is read once more, since it can end in the gap after the wait's last read.
 */
export async function awaitInlineAudioJob<K extends AudioJobKind>(
  jobId: string,
  kind: K,
  wait: { receivedAt: Date | undefined; minStepMs: number }
): Promise<InlineAudioJobOutcome<K>> {
  const inline = ofKind(await runAudioJobInline(jobId, audioJobInlineOptions(wait.receivedAt, wait.minStepMs)), kind);
  const job = inline ?? ofKind(await generationJobRepository.findById(jobId), kind);
  if (!job) return { status: 'gone' };
  if (isTerminal(job)) return { status: 'ended', job };
  if (job.payload.saveToFiles) return { status: 'outlasting', job };

  const cancel = await requestAudioJobCancel(job);
  // A cancel refused because the job ended in the meantime: it can still be delivered.
  const ended = ofKind(cancel.job, kind);
  if (cancel.status === 'unchanged' && ended && isTerminal(ended)) return { status: 'ended', job: ended };
  return { status: 'unretrievable', job, cancel: cancel.status };
}

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
 * for; a clip kept in the generated bucket despite asking means the Files write was refused or failed and fell back,
 * for the reason the store step recorded.
 */
export async function savedCopyOf(
  output: AudioJobOutput | undefined,
  saveToFiles: boolean
): Promise<SaveGeneratedAssetResult | undefined> {
  if (!saveToFiles) return undefined;
  if (output?.location !== 'files' || !output.fileId) {
    return { saved: false, reason: output?.filesSkipReason ?? 'error' };
  }
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
