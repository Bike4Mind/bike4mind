import type {
  GeneratedAssetLineageEntry,
  GeneratedAssetMetadata,
  GenerationJobDelivery,
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  UsageEventStatus,
  VideoGenerationSettings,
  VideoInputImageRef,
  VideoProviderId,
  VideoValidationErrorCode,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { VideoProviderRegistry } from '@bike4mind/utils/videoProviders';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { SaveGeneratedAssetResult } from '../generatedAssets';

export { isUsableApiKey } from '../generationJobs/apiKey';

// Stamped on the job as deadlineAt at create; the engine fails a pending or running job past it.
export const VIDEO_JOB_MAX_WALL_CLOCK_MS = 20 * 60_000;

export type VideoJobDeps = {
  repository: IGenerationJobRepository;
  providers: VideoProviderRegistry;
  getSettings(): Promise<{ enforceCredits: boolean; videoGeneration: VideoGenerationSettings | undefined }>;
  resolveApiKey(providerId: VideoProviderId, userId: string): Promise<string | null>;
  /** Owner-only for either kind; null for anything the requester cannot use (missing, foreign, malformed). */
  loadInputImage(userId: string, ref: VideoInputImageRef): Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * saveGeneratedAsset bound to the user's files. Idempotent per `generation.jobId`, which the store step relies
   * on: it can run twice for one job (a crash before its terminal commit). An abort of `signal`, the step's
   * lease-bounded signal, must reject rather than report an ordinary save failure.
   */
  saveToFiles(params: {
    userId: string;
    bytes: Buffer;
    contentType: string;
    generation: GeneratedAssetMetadata & { jobId: string };
    derivedFrom?: GeneratedAssetLineageEntry[];
    /** A chat-made job's quest; the save links the file to its notebook, which scopes the grants that notebook mints. */
    questId?: string;
    signal: AbortSignal;
  }): Promise<SaveGeneratedAssetResult>;
  saveToGeneratedBucket(params: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<{ s3Key: string }>;
  credits: CreditHoldAdapters;
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  recordUsage(event: {
    job: IGenerationJobDocumentOf<'video'>;
    creditsCharged: number;
    costUsd: number;
    durationSeconds: number;
    /** `refusal` for a block the provider billed: spend with no video delivered. */
    status: Extract<UsageEventStatus, 'ok' | 'refusal'>;
  }): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateVideoJobDeps = VideoJobDeps & {
  assertModelAdmission(userId: string, modelId: string, adminRoleWithheld?: boolean): Promise<void>;
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
};

export type CreateVideoJobInput = {
  user: { id: string; organizationId: string | null; adminRoleWithheld?: boolean };
  /** Untrusted: parsed and validated by createVideoJob. */
  request: unknown;
  source: GenerationJobSource;
  idempotencyKey?: string;
  questId?: string;
  delivery?: GenerationJobDelivery;
};

export type CreateVideoJobErrorCode =
  | VideoValidationErrorCode
  | 'invalid_request'
  | 'model_disabled'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'input_image_not_found'
  | 'idempotency_key_reused'
  // Never returned by createVideoJob itself: the agent-mode per-run cap (agentExecutor.videoToolConfig.ts).
  | 'clip_limit_reached'
  // Never returned by createVideoJob itself: the voice turn was stopped before the job started (voiceVideoToolConfig.ts).
  | 'turn_cancelled';

export type CreateVideoJobResult =
  | { ok: true; job: IGenerationJobDocumentOf<'video'>; created: boolean }
  | { ok: false; status: 400 | 402 | 403 | 404 | 422; code: CreateVideoJobErrorCode; message: string };
