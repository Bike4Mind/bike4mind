import type { ProviderJobHandle, ProviderOutput, VideoGenerationRequest, VideoProviderId } from '../../video';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType, type CreditHoldRecord } from './CreditHolderTypes';

export const GENERATION_JOB_KINDS = ['video'] as const;
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number];

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
};

export interface IGenerationJob {
  /** One kind today; becomes a union of { kind, payload } pairs when a second kind lands. */
  kind: GenerationJobKind;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  ownerId: string;
  requestedBy: string;
  source: GenerationJobSource;
  state: GenerationJobState;
  payload: VideoJobPayload;
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
}

export type IGenerationJobDocument = IGenerationJob & IMongoDocument;

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

export type GenerationJobCreateInput = Omit<IGenerationJob, 'createdAt' | 'updatedAt'> & {
  /**
   * Caller-generated id, so a create whose outcome is unknown (an error after the insert may have landed)
   * can be resolved by looking the job up. Must match GENERATION_JOB_ID_PATTERN; anything else throws.
   */
  id?: string;
};

export type StalledJobLimits = { inFlight: number; terminal: number };

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
}
