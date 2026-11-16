import {
  extensionFromMimeType,
  type AudioJobOutput,
  type GeneratedAssetMetadata,
  type GenerationJobError,
  type GenerationJobErrorCode,
  type IGenerationJobDocumentOf,
} from '@bike4mind/common';
import { mp3DurationSeconds } from '@bike4mind/utils/musicProviders';
import { ProviderOutputTooLargeError, type ProviderOutput } from '@bike4mind/utils/generationProviders';
import { storeGeneratedOutput } from '../generationJobs/storeOutput';
import type { GenerationJobStepContext, StepResult } from '../generationJobs/types';
import type { AudioJobDeps } from './types';

export type AudioJobKind = 'speech' | 'sound_effect';
type AudioJob = IGenerationJobDocumentOf<AudioJobKind>;

const MP3_CONTENT_TYPE = 'audio/mpeg';
const MAX_RAW_PROVIDER_BYTES = 16 * 1024;
const BUCKET_FOLDER = 'generated-audio';

// Neither carries a payload, so each is a step result of any kind.
type FailedStep = Extract<StepResult, { next: 'failed' }>;
type BlockedStep = { next: 'blocked'; error: GenerationJobError; rawProviderError?: unknown };

export const failStep = (code: GenerationJobErrorCode, message: string, rawProviderError?: unknown): FailedStep => ({
  next: 'failed',
  error: { code, message },
  rawProviderError,
});

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
      signal,
    });
    return { location: 'generated', s3Key, ...measured };
  }

  const { location } = await storeGeneratedOutput(
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
  return { ...location, ...measured };
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
