import {
  extensionFromMimeType,
  type AudioJobOutput,
  type GeneratedAssetMetadata,
  type GenerationJobError,
  type GenerationJobErrorCode,
  type IGenerationJobDocumentOf,
  type StorageLimitErrorInfo,
} from '@bike4mind/common';
import { mp3DurationSeconds } from '@bike4mind/utils/musicProviders';
import { ProviderOutputTooLargeError, type ProviderOutput } from '@bike4mind/utils/generationProviders';
import { FALLBACK_SAVE_BUDGET_MS, storeGeneratedOutput } from '../generationJobs/storeOutput';
import type { GenerationJobStepContext, StepResult } from '../generationJobs/types';
import type { AudioJobDeps, CreateAudioJobInput, CreateAudioJobResult, CreateSpeechJobDeps } from './types';

export type AudioJobKind = 'speech' | 'sound_effect';
type AudioJob = IGenerationJobDocumentOf<AudioJobKind>;

const MP3_CONTENT_TYPE = 'audio/mpeg';
// A long synthesis on either vendor fits well inside this; there is no per-call deadline to size it from.
const SPEECH_INLINE_MIN_STEP_MS = 40_000;
// Under the sound generator's own 45s ceiling (SOUND_GENERATION_TIMEOUT_MS), which never fits the sync routes' step
// window (syncAudioJob.ts). A clip still generating when the step budget runs out is cut off as that timeout would
// cut it, and the job fails with its hold returned.
const SOUND_EFFECT_INLINE_MIN_STEP_MS = 40_000;
const MAX_RAW_PROVIDER_BYTES = 16 * 1024;
// A clip's size is only known once it is made, so the create-time check refuses only a quota with no room at all.
const MIN_STORABLE_CLIP_BYTES = 1;
const BUCKET_FOLDER = 'generated-audio';

/** The least step budget to start an inline step with (runJobInline's minStepMs): one provider call. */
export const inlineMinStepMs = (kind: AudioJobKind): number =>
  kind === 'speech' ? SPEECH_INLINE_MIN_STEP_MS : SOUND_EFFECT_INLINE_MIN_STEP_MS;

// Neither carries a payload, so each is a step result of any kind.
type FailedStep = Extract<StepResult, { next: 'failed' }>;
type BlockedStep = { next: 'blocked'; error: GenerationJobError; rawProviderError?: unknown };

// The Retry-After for a provider 429 that carried no usable hint of its own.
export const RATE_LIMITED_RETRY_AFTER_SECONDS = 30;

export const failStep = (
  code: GenerationJobErrorCode,
  message: string,
  rawProviderError?: unknown,
  details: Pick<GenerationJobError, 'providerStatus' | 'retryAfterSeconds'> = {}
): FailedStep => ({
  next: 'failed',
  error: { code, message, ...details },
  rawProviderError,
});

/**
 * A provider at capacity. Fails terminally rather than retrying: a sync audio job answers a caller waiting inline,
 * and the engine's backoff would outlive that wait, so the caller would be told it failed while it went on to bill.
 */
export const rateLimitedStep = (
  message: string,
  retryAfterSeconds = RATE_LIMITED_RETRY_AFTER_SECONDS,
  raw?: unknown
): FailedStep => failStep('provider_error', message, boundRawPayload(raw), { providerStatus: 429, retryAfterSeconds });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The HTTP status toAudioProviderResult records on a provider's refusal. */
export const providerStatusOf = (raw: unknown): number | undefined =>
  isRecord(raw) && typeof raw.status === 'number' ? raw.status : undefined;

/** A provider's definitive refusal, keeping its HTTP status on the job error for the synchronous routes. */
export const providerFailedStep = (result: { retryable: boolean; message: string; raw?: unknown }): FailedStep => {
  // Retryable only when the provider definitively generated nothing (a 429).
  if (result.retryable) return rateLimitedStep(result.message, undefined, result.raw);
  const providerStatus = providerStatusOf(result.raw);
  return failStep(
    'provider_error',
    result.message,
    boundRawPayload(result.raw),
    providerStatus === undefined ? {} : { providerStatus }
  );
};

export const contentBlocked = (raw: unknown): BlockedStep => ({
  next: 'blocked',
  error: { code: 'content_blocked', message: 'The provider declined this request under its content policy' },
  rawProviderError: boundRawPayload(raw),
});

// The raw payload rides on the job document, and a provider can echo the request or an audio body into it.
export const boundRawPayload = (raw: unknown): unknown => {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return '[raw provider payload not serializable]';
  }
  if (json === undefined || json.length <= MAX_RAW_PROVIDER_BYTES) return raw;
  return `${json.slice(0, MAX_RAW_PROVIDER_BYTES)}...[truncated, ${json.length} chars total]`;
};

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Providers label MP3 as audio/mp3 or with parameters; the duration scan and the saved type key off one form.
const normalizeContentType = (contentType: string): string => {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base === 'audio/mp3' ? MP3_CONTENT_TYPE : base;
};

/** The provider's bytes, or an output_too_large failure. Other fetch errors propagate (an unknown outcome). */
export async function fetchAudio(
  fetchOutput: () => Promise<Buffer>,
  output: ProviderOutput
): Promise<{ bytes: Buffer; contentType: string } | { tooLarge: string }> {
  try {
    const bytes = await fetchOutput();
    return { bytes, contentType: normalizeContentType(output.contentType ?? MP3_CONTENT_TYPE) };
  } catch (error) {
    if (error instanceof ProviderOutputTooLargeError) return { tooLarge: error.message };
    throw error;
  }
}

/**
 * Keeps a clip in the user's Files (falling back to the generated bucket, since a sync submit cannot retry), or
 * only in the bucket for a job that opted out of Files.
 */
export async function storeAudioOutput(
  job: AudioJob,
  params: { bytes: Buffer; contentType: string; generation: GeneratedAssetMetadata & { jobId: string } },
  { signal }: GenerationJobStepContext,
  deps: AudioJobDeps
): Promise<AudioJobOutput> {
  const { bytes, contentType, generation } = params;
  const extension = extensionFromMimeType(contentType) ?? 'bin';
  // The frame scan would false-sync on non-MP3 audio, so only MP3 is measured.
  const durationSeconds = contentType === MP3_CONTENT_TYPE ? mp3DurationSeconds(bytes) : undefined;
  const measured = {
    contentType,
    bytes: bytes.byteLength,
    ...(durationSeconds !== undefined && { durationSeconds }),
  };

  if (!job.payload.saveToFiles) {
    const { s3Key } = await deps.saveToGeneratedBucket({
      key: `${BUCKET_FOLDER}/${job.ownerId}/${job.id}.${extension}`,
      bytes,
      contentType,
      // As storeGeneratedOutput's fallback: an aborted step signal would lose a clip the provider already billed.
      signal: signal.aborted ? AbortSignal.timeout(FALLBACK_SAVE_BUDGET_MS) : signal,
    });
    return { location: 'generated', s3Key, ...measured };
  }

  const { location, filesSkipReason } = await storeGeneratedOutput(
    {
      job,
      noun: job.kind,
      bytes,
      contentType,
      generation,
      sessionId: job.payload.sessionId,
      questId: job.questId,
      bucketFolder: BUCKET_FOLDER,
      extension,
      onFilesError: 'fallback',
      signal,
    },
    deps
  );
  return { ...location, ...measured, ...(filesSkipReason && { filesSkipReason }) };
}

/** Speech and sound-effect jobs finish in submit, so the async steps are never reached. */
export const unreachableStep = (
  job: Pick<AudioJob, 'kind' | 'id' | 'state'>,
  step: string,
  deps: Pick<AudioJobDeps, 'logger'>
): FailedStep => {
  deps.logger.error(`${job.kind}_job_unexpected_step`, { jobId: job.id, state: job.state, step });
  return failStep('provider_error', `${job.kind} jobs finish in submit; ${step} is never reached`);
};

type DailyLimitReached = Extract<CreateAudioJobResult<never>, { code: 'daily_limit_reached' }>;

/** The free-tier daily cap, checked before the hold; it counts credits, so it applies only while they are enforced. */
export async function dailyLimitRefusal(
  user: CreateAudioJobInput['user'],
  enforceCredits: boolean,
  deps: Pick<CreateSpeechJobDeps, 'checkDailySpendCap'>
): Promise<DailyLimitReached | undefined> {
  if (!enforceCredits || !deps.checkDailySpendCap) return undefined;
  const refusal = await deps.checkDailySpendCap({ userId: user.id, billingOrganizationId: user.organizationId });
  if (!refusal) return undefined;
  return { ok: false, status: 429, code: 'daily_limit_reached', ...refusal };
}

/**
 * The quota refusal for a job that would save to Files, checked at create only for an account that is already
 * full. Anything else is checked against the real clip at store time, where a clip that does not fit is kept in the
 * generated bucket and reported as skipped (AudioJobOutput.filesSkipReason).
 */
export const fullFilesQuota = (
  userId: string,
  deps: Pick<CreateSpeechJobDeps, 'checkStorageFor'>
): Promise<StorageLimitErrorInfo | undefined> => deps.checkStorageFor(userId, MIN_STORABLE_CLIP_BYTES);
