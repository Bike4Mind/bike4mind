import type { ProviderOutput } from '../../generation';
import type { MusicGenerationRequest, MusicProviderId } from '../../music';
import type { ProviderJobHandle, VideoGenerationRequest, VideoProviderId } from '../../video';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType, type CreditHoldRecord } from './CreditHolderTypes';

export const GENERATION_JOB_KINDS = ['video', 'music'] as const;
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number];

/** A job a chat message started, as stored on the quest: the kind picks the card and the endpoint that reads it. */
export type GenerationJobRef = { id: string; kind: GenerationJobKind };

/**
 * The jobs a quest started, oldest first. Quests written before `generationJobs` existed only carry
 * `videoJobIds`, so those read as video jobs (no backfill).
 */
export const questGenerationJobs = (quest: {
  generationJobs?: readonly GenerationJobRef[];
  videoJobIds?: readonly string[];
}): GenerationJobRef[] => {
  const legacy = (quest.videoJobIds ?? []).map((id): GenerationJobRef => ({ id, kind: 'video' }));
  const byId = new Map<string, GenerationJobRef>();
  for (const ref of [...legacy, ...(quest.generationJobs ?? [])]) {
    if (!byId.has(ref.id)) byId.set(ref.id, { id: ref.id, kind: ref.kind });
  }
  return [...byId.values()];
};

export const GENERATION_JOB_STATES = [
  'pending',
  'running',
  'storing',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number];

export const TERMINAL_GENERATION_JOB_STATES: readonly GenerationJobState[] = [
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
];

export const GENERATION_JOB_SOURCES = ['api', 'studio', 'agent'] as const;
export type GenerationJobSource = (typeof GENERATION_JOB_SOURCES)[number];

export const GENERATION_JOB_ERROR_CODES = [
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'orphaned_submit',
  'region_unavailable',
  'output_too_large',
  'input_image_not_found',
  'enqueue_failed',
  'cancelled',
] as const;
export type GenerationJobErrorCode = (typeof GENERATION_JOB_ERROR_CODES)[number];

export type GenerationJobError = { code: GenerationJobErrorCode; message: string };

export type VideoJobOutput = {
  location: 'files' | 'generated';
  s3Key: string;
  fileId?: string;
  contentType: string;
  bytes: number;
  durationSeconds: number;
};

export type VideoJobPayload = {
  request: VideoGenerationRequest;
  providerId: VideoProviderId;
  providerHandle?: ProviderJobHandle;
  providerOutput?: ProviderOutput;
  reportedDurationSeconds?: number;
  output?: VideoJobOutput;
  /**
   * The provider generated the clip, billed it, then blocked it: terminal handling settles the hold instead of
   * releasing it. Persisted with the blocked state so a sweep recovery after a crash makes the same choice.
   */
  billedBlock?: boolean;
};

/** The validated request as persisted: defaults resolved, without the in-memory validation brand. */
export type StoredMusicRequest = MusicGenerationRequest & { durationSeconds: number; instrumental: boolean };

/** Same storage fields as VideoJobOutput, so kind-agnostic readers (job updates, signed URLs) serve both. */
export type MusicJobOutput = VideoJobOutput & {
  /** What the provider sang, as plain lines; absent for instrumental output. */
  lyrics?: string;
};

/**
 * Music providers return the finished song from one blocking call, so the output is stored in the submit step:
 * provider bytes never reach this payload.
 */
export type MusicJobPayload = {
  request: StoredMusicRequest;
  providerId: MusicProviderId;
  /** The notebook the song was made in, for in-chat producers. */
  sessionId?: string;
  reportedDurationSeconds?: number;
  output?: MusicJobOutput;
  /** As VideoJobPayload.billedBlock. */
  billedBlock?: boolean;
};

/** Each kind's payload; the job type is a union discriminated on `kind`. */
export type GenerationJobPayloads = {
  video: VideoJobPayload;
  music: MusicJobPayload;
};

type GenerationJobFields = {
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  ownerId: string;
  requestedBy: string;
  source: GenerationJobSource;
  state: GenerationJobState;
  progress?: number;
  pollCount: number;
  attempts: number;
  cancelRequested: boolean;
  submitAttemptedAt?: Date | null;
  leaseUntil?: Date | null;
  nextPollAt?: Date | null;
  deadlineAt: Date;
  idempotencyKey?: string;
  creditHold: CreditHoldRecord | null;
  settledCredits?: number;
  error?: GenerationJobError;
  rawProviderError?: unknown;
  terminalHandlingClaimedAt?: Date | null;
  terminalHandledAt?: Date | null;
  questId?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type GenerationJobByKind = {
  [K in GenerationJobKind]: GenerationJobFields & { kind: K; payload: GenerationJobPayloads[K] };
};

export type IGenerationJob = GenerationJobByKind[GenerationJobKind];

/** The job of one kind (or of a union of kinds). */
export type IGenerationJobOf<K extends GenerationJobKind> = Extract<IGenerationJob, { kind: K }>;

export type IGenerationJobDocument = IGenerationJob & IMongoDocument;

export type IGenerationJobDocumentOf<K extends GenerationJobKind> = Extract<IGenerationJobDocument, { kind: K }>;

export const isGenerationJobOfKind = <K extends GenerationJobKind>(
  job: IGenerationJobDocument,
  kind: K
): job is IGenerationJobDocumentOf<K> => job.kind === kind;

export type GenerationJobCommit = Partial<
  Pick<
    IGenerationJob,
    | 'state'
    | 'payload'
    | 'progress'
    | 'pollCount'
    | 'attempts'
    | 'nextPollAt'
    | 'error'
    | 'rawProviderError'
    | 'submitAttemptedAt'
  >
>;

/**
 * Who a commit is written for, and so when it still applies:
 * - `lease`: a worker's step. A worker whose lease expired mid-step (a slow provider call, a paused process) must
 *   not overwrite the job a newer worker has since advanced, so it applies only while the stored leaseUntil
 *   still equals the token it acquired.
 * - `unstarted`: a caller failing a job no worker has touched. It applies only while the job is pending, was never
 *   submitted and holds no live lease, so a worker that already started always wins.
 */
export type GenerationJobCommitGuard = { kind: 'lease'; leaseToken: Date } | { kind: 'unstarted'; now: Date };

// A lowercase 24-hex ObjectId string; exact, so the stored id equals the supplied one.
export const GENERATION_JOB_ID_PATTERN = /^[0-9a-f]{24}$/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type GenerationJobCreateInput = DistributiveOmit<IGenerationJob, 'createdAt' | 'updatedAt'> & {
  /**
   * Caller-generated id, so a create whose outcome is unknown (an error after the insert may have landed)
   * can be resolved by looking the job up. Must match GENERATION_JOB_ID_PATTERN; anything else throws.
   */
  id?: string;
};

export type StalledJobLimits = { inFlight: number; terminal: number };

export type ListByRequesterQuery = {
  requestedBy: string;
  kind: GenerationJobKind;
  state?: GenerationJobState;
  source?: GenerationJobSource;
  /** Exclusive: only jobs whose id sorts before this one (the previous page's last id). */
  beforeId?: string;
  limit: number;
};

export interface IGenerationJobRepository extends IBaseRepository<IGenerationJobDocument> {
  createJob(input: GenerationJobCreateInput): Promise<IGenerationJobDocument>;
  findByIdempotencyKey(
    ownerType: IGenerationJob['ownerType'],
    ownerId: string,
    key: string
  ): Promise<IGenerationJobDocument | null>;
  /**
   * Leases the job until `leaseUntil`, which doubles as the lease token for commit. A lease is only granted once
   * the previous one has expired, so a newer lease always carries a later token than the one it replaced.
   */
  acquireLease(id: string, now: Date, leaseUntil: Date): Promise<IGenerationJobDocument | null>;
  markSubmitAttempted(id: string, at: Date): Promise<void>;
  /** Applies the update and releases the lease. Null when the guard no longer holds (or the job is gone). */
  commit(
    id: string,
    update: GenerationJobCommit,
    guard: GenerationJobCommitGuard
  ): Promise<IGenerationJobDocument | null>;
  /** Only a pending or running job can be cancelled; storing output is already paid for. */
  requestCancel(id: string): Promise<IGenerationJobDocument | null>;
  claimTerminalHandling(id: string, at: Date): Promise<boolean>;
  /** Written by a kind's onTerminal right after credits move; the job's lease is not involved. */
  recordSettlement(id: string, settledCredits: number): Promise<void>;
  markTerminalHandled(id: string, at: Date): Promise<void>;
  /** Separate limits so an in-flight backlog can never starve terminal handling (credit release). */
  findStalled(overdueBefore: Date, limits: StalledJobLimits): Promise<IGenerationJobDocument[]>;
  /** Newest first, by id. Visibility is the requester, not the credit owner: org members never see each other's jobs. */
  listByRequester(query: ListByRequesterQuery): Promise<IGenerationJobDocument[]>;
}
