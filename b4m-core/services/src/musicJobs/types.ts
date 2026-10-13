import type {
  GeneratedAssetMetadata,
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  MusicGenerationSettings,
  MusicProviderId,
  MusicValidationErrorCode,
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
   * saveGeneratedAsset bound to the user's files. Idempotent per `generation.jobId`. An abort of `signal`, the
   * step's lease-bounded signal, must reject rather than report an ordinary save failure.
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
    /** Billed seconds (billedMusicSeconds), the usage event's units. */
    durationSeconds: number;
    /** `refusal` for a block the provider billed: spend with no song delivered. */
    status: Extract<UsageEventStatus, 'ok' | 'refusal'>;
  }): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateMusicJobDeps = MusicJobDeps & {
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  /** Whether the user's Files quota has room for `bytes` more; the song is saved there, as saveToFiles does. */
  hasStorageFor(userId: string, bytes: number): Promise<boolean>;
};

// The most a song can take per second (320 kbps MP3), for the create-time storage check.
export const MAX_MUSIC_BYTES_PER_SECOND = 40_000;

export type CreateMusicJobInput = {
  user: { id: string; organizationId: string | null };
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
  | { ok: false; status: 400 | 402 | 403 | 422; code: CreateMusicJobErrorCode; message: string };
