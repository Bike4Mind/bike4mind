import type {
  GeneratedAssetLineageEntry,
  GeneratedAssetMetadata,
  GenerationJobDelivery,
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  ImageProviderId,
  ImageValidationFailure,
  StorageLimitErrorInfo,
  UsageEventStatus,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ImageProviderRegistry } from '@bike4mind/utils/imageProviders';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { OutputModerationVerdict } from '../generationJobs/storeOutput';
import type { SaveGeneratedAssetResult } from '../generatedAssets';

// Stamped on the job as deadlineAt at create; covers the queue wait plus one provider call, or an async provider's
// task from submit through its last poll.
export const IMAGE_JOB_MAX_WALL_CLOCK_MS = 10 * 60_000;

// Most jobs one "make N" request creates.
export const IMAGE_JOB_BATCH_MAX = 4;

// A generous single-image size (a large PNG), for the create-time storage check.
export const IMAGE_JOB_OUTPUT_BYTES_ESTIMATE = 16 * 1024 * 1024;

export type ImageJob = IGenerationJobDocumentOf<'image'>;

/** What our own scan decided about a generated image. */
export type ImageModerationVerdict = OutputModerationVerdict;

export type ImageJobDeps = {
  repository: IGenerationJobRepository;
  providers: ImageProviderRegistry;
  getSettings(): Promise<{ enforceCredits: boolean }>;
  resolveApiKey(providerId: ImageProviderId, userId: string): Promise<string | null>;
  /** Owner-only: an input becomes provider input, and a shared image is not the requester's to send out. */
  loadInputFile(userId: string, fileId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * Our post-generation scan, run before anything is stored (the same gate the chat image path runs). A throw means
   * the scan could not run; the image is then not kept.
   */
  moderate(params: { job: ImageJob; bytes: Buffer; mimeType: string }): Promise<ImageModerationVerdict>;
  /**
   * saveGeneratedAsset bound to the user's files. Idempotent per `generation.jobId`. An abort of `signal`, the step's
   * lease-bounded signal, must reject rather than report an ordinary save failure.
   */
  saveToFiles(params: {
    userId: string;
    bytes: Buffer;
    contentType: string;
    generation: GeneratedAssetMetadata & { jobId: string };
    derivedFrom?: GeneratedAssetLineageEntry[];
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
    job: ImageJob;
    creditsCharged: number;
    costUsd: number;
    /** `refusal` for a block that was billed: spend with no image delivered. */
    status: Extract<UsageEventStatus, 'ok' | 'refusal'>;
  }): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateImageJobsDeps = ImageJobDeps & {
  assertModelAdmission(userId: string, modelId: string, adminRoleWithheld?: boolean): Promise<void>;
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  /** The refusal detail when the user's Files quota lacks room for `bytes` more; undefined when there is room. */
  checkStorageFor(userId: string, bytes: number): Promise<StorageLimitErrorInfo | undefined>;
};

export type CreateImageJobsInput = {
  user: { id: string; organizationId: string | null; adminRoleWithheld?: boolean };
  /** Untrusted: parsed and validated by createImageJobs. */
  request: unknown;
  /** Images to make, one job each. */
  count: number;
  source: GenerationJobSource;
  apiKeyId?: string;
  /** Where the finished batch is posted besides the websocket update; every job in the batch carries it. */
  delivery?: GenerationJobDelivery;
  /** Scopes the whole batch; each job holds `${idempotencyKey}:${index}/${count}`. */
  idempotencyKey?: string;
};

export type CreateImageJobsErrorCode =
  | 'invalid_request'
  | 'invalid_count'
  | 'unsupported_by_model'
  | 'model_unavailable'
  | 'input_image_not_found'
  | 'unsupported_input_image'
  | 'insufficient_credits'
  | 'storage_quota_exceeded'
  | 'idempotency_key_reused';

export type CreateImageJobsResult =
  | { ok: true; groupId: string; jobs: ImageJob[]; created: boolean }
  | {
      ok: false;
      status: 400 | 402 | 422;
      code: Exclude<CreateImageJobsErrorCode, 'storage_quota_exceeded' | 'unsupported_by_model'>;
      message: string;
    }
  // Every reason the model cannot honour the request, each with its user-facing why-not `reason`.
  | {
      ok: false;
      status: 422;
      code: 'unsupported_by_model';
      message: string;
      failures: readonly ImageValidationFailure[];
    }
  | { ok: false; status: 400; code: 'storage_quota_exceeded'; message: string; storage: StorageLimitErrorInfo };
