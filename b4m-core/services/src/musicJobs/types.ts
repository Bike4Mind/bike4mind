import type {
  GeneratedAssetMetadata,
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  MusicGenerationSettings,
  MusicProviderId,
  MusicValidationErrorCode,
  StorageLimitErrorInfo,
  UsageEventStatus,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { MusicProviderRegistry } from '@bike4mind/utils/musicProviders';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { SaveGeneratedAssetResult } from '../generatedAssets';

// Stamped on the job as deadlineAt at create; the engine fails a pending job past it.
export const MUSIC_JOB_MAX_WALL_CLOCK_MS = 15 * 60_000;

export type MusicJob = IGenerationJobDocumentOf<'music'>;

export type MusicJobDeps = {
  repository: IGenerationJobRepository;
  providers: MusicProviderRegistry;
  getSettings(): Promise<{ enforceCredits: boolean; musicGeneration: MusicGenerationSettings | undefined }>;
  resolveApiKey(providerId: MusicProviderId, userId: string): Promise<string | null>;
  /**
   * saveGeneratedAsset bound to the user's files. Idempotent per `generation.jobId`. `signal` is the step's
   * lease-bounded signal; its abort must reject rather than report an ordinary save failure. The handler then
   * falls back to saveToGeneratedBucket with a fresh bounded signal, so the song is still kept.
   */
  saveToFiles(params: {
    userId: string;
    bytes: Buffer;
    contentType: string;
    generation: GeneratedAssetMetadata & { jobId: string };
    sessionId?: string;
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
    job: MusicJob;
    creditsCharged: number;
    costUsd: number;
    /** Seconds the provider delivered (uncapped), the usage event's units; costUsd is priced on it. */
    durationSeconds: number;
    /** `refusal` for a block the provider billed: spend with no song delivered. */
    status: Extract<UsageEventStatus, 'ok' | 'refusal'>;
  }): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateMusicJobDeps = MusicJobDeps & {
  assertModelAdmission(userId: string, modelId: string, adminRoleWithheld?: boolean): Promise<void>;
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  /** The refusal detail when the user's Files quota lacks room for `bytes` more (the song is saved there, as saveToFiles does); undefined when there is room. */
  checkStorageFor(userId: string, bytes: number): Promise<StorageLimitErrorInfo | undefined>;
};

// The most a song can take per second (320 kbps MP3), for the create-time storage check.
export const MAX_MUSIC_BYTES_PER_SECOND = 40_000;

export type CreateMusicJobInput = {
  user: { id: string; organizationId: string | null; adminRoleWithheld?: boolean };
  /** Untrusted: parsed and validated by createMusicJob. */
  request: unknown;
  source: GenerationJobSource;
  idempotencyKey?: string;
  /** The notebook and message the song belongs to, for in-chat producers. */
  sessionId?: string;
  questId?: string;
};

export type CreateMusicJobErrorCode =
  | MusicValidationErrorCode
  | 'invalid_request'
  | 'model_disabled'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'storage_quota_exceeded'
  | 'idempotency_key_reused';

export type CreateMusicJobResult =
  | { ok: true; job: MusicJob; created: boolean }
  | {
      ok: false;
      status: 400 | 402 | 403 | 422;
      code: Exclude<CreateMusicJobErrorCode, 'storage_quota_exceeded'>;
      message: string;
    }
  // A 400 like the Files routes' storage_limit_exceeded, carrying the same used/limit/requested detail.
  | { ok: false; status: 400; code: 'storage_quota_exceeded'; message: string; storage: StorageLimitErrorInfo };
