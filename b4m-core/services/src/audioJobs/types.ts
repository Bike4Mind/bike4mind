import type {
  GeneratedAssetMetadata,
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  SoundGenerationVendor,
  StorageLimitErrorInfo,
  VoiceGenerationVendor,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { SoundEffectProviderRequest, SpeechProviderRequest } from '@bike4mind/utils/audioProviders';
import type { SyncGenerationProvider } from '@bike4mind/utils/generationProviders';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { SaveGeneratedAssetResult } from '../generatedAssets';

// Stamped on the job as deadlineAt at create; one provider call takes seconds, so this only bounds retries.
export const AUDIO_JOB_MAX_WALL_CLOCK_MS = 5 * 60_000;

// Keyed by vendor rather than by provider id, so a stage's test provider (id 'test') can stand in for a vendor.
export type SpeechJobProvider = SyncGenerationProvider<string, string, SpeechProviderRequest>;
export type SoundEffectJobProvider = SyncGenerationProvider<string, string, SoundEffectProviderRequest>;

export type SpeechJob = IGenerationJobDocumentOf<'speech'>;
export type SoundEffectJob = IGenerationJobDocumentOf<'sound_effect'>;

/** What the speech and sound-effect handlers share: storage, credits and the engine's plumbing. */
export type AudioJobDeps = {
  repository: IGenerationJobRepository;
  getSettings(): Promise<{ enforceCredits: boolean }>;
  /** As MusicJobDeps.saveToFiles. */
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
  now(): Date;
  logger: Logger;
};

export type SpeechJobDeps = AudioJobDeps & {
  /** The registered vendors; a candidate without one is skipped. */
  providers: Partial<Record<VoiceGenerationVendor, SpeechJobProvider>>;
  resolveApiKey(vendor: VoiceGenerationVendor, userId: string): Promise<string | null>;
  /**
   * The voice to synthesize with: the requested one, else the user's own (an ElevenLabs voice, or the OpenAI
   * preference), else the admin default. Undefined lets the provider apply its own default.
   */
  resolveVoice(params: {
    vendor: VoiceGenerationVendor;
    userId: string;
    requestedVoice?: string;
    preferredVoice?: string;
  }): Promise<string | undefined>;
  recordUsage(event: {
    job: SpeechJob;
    provider: VoiceGenerationVendor;
    model: string;
    characters: number;
    creditsCharged: number;
    costUsd: number;
  }): Promise<void>;
};

export type SoundEffectJobDeps = AudioJobDeps & {
  providers: Partial<Record<SoundGenerationVendor, SoundEffectJobProvider>>;
  resolveApiKey(vendor: SoundGenerationVendor, userId: string): Promise<string | null>;
  /**
   * Runs the provider call in the vendor's shared-key concurrency slots (runElevenLabsWithCapacity): retries an
   * attempt that throws ProviderRateLimitError within its budget, and throws ProviderBusyError once capacity does not
   * free up in time. `timeoutMs` is what is left of that budget. Absent: the call runs unslotted, once.
   */
  runWithCapacity?<T>(apiKey: string, attempt: (call: { timeoutMs: number }) => Promise<T>): Promise<T>;
  recordUsage(event: {
    job: SoundEffectJob;
    billedSeconds: number;
    creditsCharged: number;
    costUsd: number;
  }): Promise<void>;
};

/** A free-tier user who has spent today's allowance: refused until `retryAfterSeconds` from now. */
export type DailySpendCapRefusal = { message: string; retryAfterSeconds: number };

type CreateAudioJobExtras = {
  assertModelAdmission(userId: string, modelId: string, adminRoleWithheld?: boolean): Promise<void>;
  /**
   * As checkFreeTierDailySpendCap (server-utils billing), checked before the hold when credits are enforced.
   * Absent: no daily cap applies.
   */
  checkDailySpendCap?(params: {
    userId: string;
    billingOrganizationId: string | null;
  }): Promise<DailySpendCapRefusal | undefined>;
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  /** As CreateMusicJobDeps.checkStorageFor. */
  checkStorageFor(userId: string, bytes: number): Promise<StorageLimitErrorInfo | undefined>;
};

export type CreateSpeechJobDeps = SpeechJobDeps &
  CreateAudioJobExtras & {
    /** Whether the user may use `modelId`; an alternate vendor whose default model is withheld is not tried. */
    isModelAdmitted(userId: string, modelId: string, adminRoleWithheld?: boolean): Promise<boolean>;
  };

export type CreateSoundEffectJobDeps = SoundEffectJobDeps & CreateAudioJobExtras;

export type CreateAudioJobInput = {
  /** `organizationId` is the account billed: the caller resolves which one the request may bill. */
  user: { id: string; organizationId: string | null; adminRoleWithheld?: boolean };
  /** Untrusted: parsed and validated by the create function. */
  request: unknown;
  source: GenerationJobSource;
  apiKeyId?: string;
  idempotencyKey?: string;
  /** false keeps the clip outside Files, for a throwaway preview. Defaults to true. */
  saveToFiles?: boolean;
  sessionId?: string;
  questId?: string;
};

export type CreateSpeechJobInput = CreateAudioJobInput & {
  /** The user's stored OpenAI voice preference. */
  preferredVoice?: string | null;
};

export type CreateAudioJobErrorCode =
  | 'invalid_request'
  | 'model_unavailable'
  | 'insufficient_credits'
  | 'storage_quota_exceeded'
  | 'daily_limit_reached'
  | 'idempotency_key_reused';

export type CreateAudioJobResult<J> =
  | { ok: true; job: J; created: boolean }
  | {
      ok: false;
      status: 400 | 402 | 422;
      code: Exclude<CreateAudioJobErrorCode, 'storage_quota_exceeded' | 'daily_limit_reached'>;
      message: string;
    }
  | { ok: false; status: 400; code: 'storage_quota_exceeded'; message: string; storage: StorageLimitErrorInfo }
  | { ok: false; status: 429; code: 'daily_limit_reached'; message: string; retryAfterSeconds: number };

export type CreateSpeechJobResult = CreateAudioJobResult<SpeechJob>;
export type CreateSoundEffectJobResult = CreateAudioJobResult<SoundEffectJob>;
