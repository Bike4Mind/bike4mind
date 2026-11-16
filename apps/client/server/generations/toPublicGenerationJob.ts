import {
  toPublicMusicJobErrorCode,
  toPublicVideoJobErrorCode,
  type GenerationJobErrorCode,
  type GenerationJobSource,
  type GenerationJobState,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type MusicJobOutput,
  type VideoJobOutput,
} from '@bike4mind/common';
import {
  OUTPUT_URL_TTL_SECONDS,
  outputUrlExpiresAt,
  toIso,
  type JobMapperDeps,
  type SignedOutput,
  type StoredOutputRef,
} from '@bike4mind/server-utils/generations/signedOutput';
import { MUSIC_JOB_ERROR_COPY, VIDEO_JOB_ERROR_COPY, type GenerationJobErrorCopy } from './generationJobErrorCopy';

type JobOutput = StoredOutputRef & { contentType: string };

/**
 * What one kind adds to the shared public resource. Field order is part of the published bytes, so each hook names
 * where its fields land.
 */
export type PublicJobProjection<
  Job extends IGenerationJobDocument,
  Output extends JobOutput,
  ObjectName extends string,
  PublicErrorCode extends GenerationJobErrorCode,
  RequestFields extends object,
  StatusFields extends object,
  OutputFields extends object,
> = {
  object: ObjectName;
  /** Folds internal-only codes into the kind's published set. */
  toPublicErrorCode(code: GenerationJobErrorCode): PublicErrorCode;
  errorCopy: GenerationJobErrorCopy;
  /** Between `state` and `source`. */
  requestFields(job: Job): RequestFields;
  /** Between `source` and `error`. */
  statusFields(job: Job): StatusFields;
  outputOf(job: Job): Output | undefined;
  /** Between `content_type` and `file_id`. */
  outputFields(output: Output): OutputFields;
};

export type PublicGenerationJob<
  ObjectName extends string,
  PublicErrorCode extends string,
  RequestFields extends object,
  StatusFields extends object,
  OutputFields extends object,
> = { id: string; object: ObjectName; state: GenerationJobState } & RequestFields & {
    source: GenerationJobSource;
  } & StatusFields & {
    error: { code: PublicErrorCode; message: string } | null;
    output:
      | ({
          availability: SignedOutput['availability'];
          url: string | null;
          expires_at: string | null;
          content_type: string;
        } & OutputFields & { file_id: string | null })
      | null;
    credits: { reserved: number | null; settled: number | null };
    created_at: string;
    updated_at: string;
  };

/** The one job -> public resource mapping behind every public generations endpoint; `projection` picks the kind. */
export async function toPublicGenerationJob<
  Job extends IGenerationJobDocument,
  Output extends JobOutput,
  ObjectName extends string,
  PublicErrorCode extends GenerationJobErrorCode,
  RequestFields extends object,
  StatusFields extends object,
  OutputFields extends object,
>(
  job: Job,
  deps: JobMapperDeps,
  projection: PublicJobProjection<Job, Output, ObjectName, PublicErrorCode, RequestFields, StatusFields, OutputFields>
): Promise<PublicGenerationJob<ObjectName, PublicErrorCode, RequestFields, StatusFields, OutputFields>> {
  const output = projection.outputOf(job);
  const signed = job.state === 'succeeded' && output ? await deps.sign(output, OUTPUT_URL_TTL_SECONDS) : null;
  const code = job.error ? projection.toPublicErrorCode(job.error.code) : null;
  return {
    id: job.id,
    object: projection.object,
    state: job.state,
    ...projection.requestFields(job),
    source: job.source,
    ...projection.statusFields(job),
    error: code ? { code, message: projection.errorCopy[code] } : null,
    output:
      signed && output
        ? {
            availability: signed.availability,
            url: signed.availability === 'ready' ? signed.url : null,
            expires_at: signed.availability === 'ready' ? outputUrlExpiresAt(deps.now()) : null,
            content_type: output.contentType,
            ...projection.outputFields(output),
            file_id: output.fileId ?? null,
          }
        : null,
    credits: { reserved: job.creditHold?.reservedCredits ?? null, settled: job.settledCredits ?? null },
    created_at: toIso(job.createdAt),
    updated_at: toIso(job.updatedAt),
  };
}

type VideoJob = IGenerationJobDocumentOf<'video'>;
type MusicJob = IGenerationJobDocumentOf<'music'>;

// Must stay in sync with VideoGenerationSchema (b4m-core/common/src/schemas/videoGenerations.ts), key order included.
export const VIDEO_GENERATION_PROJECTION = {
  object: 'video_generation' as const,
  toPublicErrorCode: toPublicVideoJobErrorCode,
  errorCopy: VIDEO_JOB_ERROR_COPY,
  requestFields: ({ payload: { request } }: VideoJob) => ({
    model: request.model,
    mode: request.mode,
    prompt: request.prompt,
    duration_seconds: request.durationSeconds,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
  }),
  statusFields: (job: VideoJob) => ({ progress: job.progress ?? null }),
  outputOf: (job: VideoJob): VideoJobOutput | undefined => job.payload.output,
  outputFields: (output: VideoJobOutput) => ({ duration_seconds: output.durationSeconds }),
};

// Must stay in sync with MusicGenerationSchema (b4m-core/common/src/schemas/musicGenerations.ts), key order included.
export const MUSIC_GENERATION_PROJECTION = {
  object: 'music_generation' as const,
  toPublicErrorCode: toPublicMusicJobErrorCode,
  errorCopy: MUSIC_JOB_ERROR_COPY,
  requestFields: ({ payload: { request } }: MusicJob) => ({
    model: request.model,
    prompt: request.prompt,
    lyrics: request.lyrics ?? null,
    instrumental: request.instrumental,
    duration_seconds: request.durationSeconds,
  }),
  statusFields: () => ({}),
  outputOf: (job: MusicJob): MusicJobOutput | undefined => job.payload.output,
  outputFields: (output: MusicJobOutput) => ({
    duration_seconds: output.durationSeconds,
    lyrics: output.lyrics ?? null,
  }),
};
