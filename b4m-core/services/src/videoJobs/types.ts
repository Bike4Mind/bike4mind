import type {
  GenerationJobSource,
  IGenerationJobDocument,
  IGenerationJobRepository,
  VideoGenerationSettings,
  VideoProviderId,
  VideoValidationErrorCode,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { VideoProviderRegistry } from '@bike4mind/utils/videoProviders';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';

// Stamped on the job as deadlineAt at create; the engine fails a pending or running job past it.
export const VIDEO_JOB_MAX_WALL_CLOCK_MS = 20 * 60_000;

export type VideoJobDeps = {
  repository: IGenerationJobRepository;
  providers: VideoProviderRegistry;
  getSettings(): Promise<{ enforceCredits: boolean; videoGeneration: VideoGenerationSettings | undefined }>;
  resolveApiKey(providerId: VideoProviderId, userId: string): Promise<string | null>;
  loadInputImage(userId: string, fileId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * Must be idempotent per jobId: the store step can run twice for one job (a crash before its terminal commit),
   * and the second call must return the first file rather than save a duplicate.
   */
  saveToFiles(params: {
    userId: string;
    jobId: string;
    bytes: Buffer;
    contentType: string;
    prompt: string;
    /** The step's lease-bounded signal; an abort must reject, never report an ordinary save failure. */
    signal: AbortSignal;
  }): Promise<
    | { saved: true; fileId: string; s3Key: string }
    | { saved: false; reason: 'storage_limit' | 'file_too_large' | 'error' }
  >;
  saveToGeneratedBucket(params: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<{ s3Key: string }>;
  credits: CreditHoldAdapters;
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  recordUsage(event: {
    job: IGenerationJobDocument;
    creditsCharged: number;
    costUsd: number;
    durationSeconds: number;
  }): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateVideoJobDeps = VideoJobDeps & {
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
};

export type CreateVideoJobInput = {
  user: { id: string; organizationId: string | null };
  /** Untrusted: parsed and validated by createVideoJob. */
  request: unknown;
  source: GenerationJobSource;
  idempotencyKey?: string;
  questId?: string;
};

export type CreateVideoJobErrorCode =
  | VideoValidationErrorCode
  | 'invalid_request'
  | 'model_disabled'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'input_image_not_found'
  | 'idempotency_key_reused';

export type CreateVideoJobResult =
  | { ok: true; job: IGenerationJobDocument; created: boolean }
  | { ok: false; status: 400 | 402 | 403 | 404 | 422; code: CreateVideoJobErrorCode; message: string };
