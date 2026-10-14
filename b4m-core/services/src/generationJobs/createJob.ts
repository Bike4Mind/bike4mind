import { Types } from 'mongoose';
import {
  CreditHolderType,
  getQuestErrorCode,
  isGenerationJobOfKind,
  type GenerationJobCreateInput,
  type GenerationJobKind,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type IGenerationJobOf,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { holdCredits, releaseCreditHold, type CreditHold, type CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from './engine';

/**
 * The kind-agnostic half of creating a job (owner, idempotency, hold, persist, enqueue), shared by every kind's
 * create function. Log events are prefixed with the kind (`video_job_create_ambiguous`, ...).
 */
export type CreateGenerationJobDeps = {
  repository: IGenerationJobRepository;
  credits: CreditHoldAdapters;
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  logger: Logger;
};

export type JobOwner = Pick<IGenerationJob, 'ownerType' | 'ownerId'>;

/** An organization member's jobs bill the organization; anyone else's bill the user. */
export const resolveJobOwner = (user: { id: string; organizationId: string | null }): JobOwner =>
  user.organizationId
    ? { ownerType: CreditHolderType.Organization, ownerId: user.organizationId }
    : { ownerType: CreditHolderType.User, ownerId: user.id };

export type CreatedJob<K extends GenerationJobKind> = { ok: true; job: IGenerationJobDocumentOf<K>; created: boolean };

export type IdempotencyKeyReused = {
  ok: false;
  status: 422;
  code: 'idempotency_key_reused';
  message: string;
};

export type InsufficientCredits = { ok: false; status: 402; code: 'insufficient_credits'; message: string };

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

// Key-sorted JSON, so the comparison matches what survives a Mongo round trip: an undefined field equals an
// absent one, and key order is irrelevant.
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested
  );

/** A key holder of another kind is a different request, whatever its body. */
export const replayOrReject = <K extends GenerationJobKind>(
  existing: IGenerationJobDocument,
  kind: K,
  request: unknown
): CreatedJob<K> | IdempotencyKeyReused =>
  isGenerationJobOfKind(existing, kind) && canonicalJson(existing.payload.request) === canonicalJson(request)
    ? { ok: true, job: existing, created: false }
    : {
        ok: false,
        status: 422,
        code: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used with a different request',
      };

/** The replay lookup for an optional key; null when there is no key or no job holds it. */
export async function findIdempotentReplay<K extends GenerationJobKind>(
  params: { kind: K; owner: JobOwner; idempotencyKey: string | undefined; request: unknown },
  deps: Pick<CreateGenerationJobDeps, 'repository'>
): Promise<CreatedJob<K> | IdempotencyKeyReused | null> {
  const { kind, owner, idempotencyKey, request } = params;
  if (!idempotencyKey) return null;
  const existing = await deps.repository.findByIdempotencyKey(owner.ownerType, owner.ownerId, idempotencyKey);
  return existing ? replayOrReject(existing, kind, request) : null;
}

/** Holds `requiredCredits` when credits are enforced; null when they are not. Insufficient credits is a value. */
export async function holdJobCredits(
  params: {
    enforceCredits: boolean;
    user: { id: string; organizationId: string | null };
    requiredCredits: number;
    featureLabel: string;
  },
  deps: Pick<CreateGenerationJobDeps, 'credits'>
): Promise<{ ok: true; hold: CreditHold | null } | InsufficientCredits> {
  if (!params.enforceCredits) return { ok: true, hold: null };
  try {
    const hold = await holdCredits(
      {
        userId: params.user.id,
        organizationId: params.user.organizationId,
        requiredCredits: params.requiredCredits,
        featureLabel: params.featureLabel,
      },
      deps.credits
    );
    return { ok: true, hold };
  } catch (error) {
    if (getQuestErrorCode(error) === 'insufficient_credits' && error instanceof Error) {
      return { ok: false, status: 402, code: 'insufficient_credits', message: error.message };
    }
    throw error;
  }
}

/**
 * The job to create, without its kind (a separate argument) and timestamps. Distributive over K, so a union of
 * kinds yields a union of per-kind jobs rather than one Omit that collapses their payloads.
 */
export type NewGenerationJob<K extends GenerationJobKind> = K extends GenerationJobKind
  ? Omit<IGenerationJobOf<K>, 'kind' | 'createdAt' | 'updatedAt'>
  : never;

/**
 * Persists a pending job that already owns `job.creditHold` and enqueues its first step. A failure to persist or
 * enqueue throws (a 5xx for the caller) after returning the hold; a lost idempotency race replays the winner.
 */
export async function persistAndEnqueueJob<K extends GenerationJobKind>(
  kind: K,
  job: NewGenerationJob<K>,
  deps: CreateGenerationJobDeps
): Promise<CreatedJob<K> | IdempotencyKeyReused> {
  const jobId = new Types.ObjectId().toHexString();
  let persisted: IGenerationJobDocumentOf<K>;
  try {
    // The one unavoidable cast: TS cannot relate a generic K to the input's union. Callers cannot mismatch kind and
    // payload, because NewGenerationJob<K> is the per-kind job for exactly this `kind`.
    const input = { ...job, kind, id: jobId } as GenerationJobCreateInput;
    persisted = expectKind(await deps.repository.createJob(input), kind);
  } catch (error) {
    const failed: FailedCreate<K> = { kind, jobId, job };
    const recovery = await recoverFailedCreate(error, failed, deps);
    if (recovery.outcome === 'replay') return recovery.result;
    if (recovery.outcome === 'failed') throw error;
    persisted = recovery.job;
  }

  try {
    await deps.enqueue(persisted.id, 0);
  } catch (error) {
    // No message will reach the job, so fail it and return its hold here, unless a worker already started it:
    // then the send landed despite the error and the job is live.
    const outcome = await runCleanup(deps, kind, { jobId: persisted.id, ownerId: job.ownerId }, () =>
      deps.engine.failBeforeStart(persisted.id, { code: 'enqueue_failed', message: 'The job could not be queued' })
    );
    if (outcome !== 'skipped') throw error;
  }
  return { ok: true, job: persisted, created: true };
}

const expectKind = <K extends GenerationJobKind>(job: IGenerationJobDocument, kind: K): IGenerationJobDocumentOf<K> => {
  if (!isGenerationJobOfKind(job, kind)) throw new Error(`expected a ${kind} generation job, got ${job.kind}`);
  return job;
};

/** Runs a cleanup step on a path that is already failing, so its own error never masks the original one. */
async function runCleanup<T>(
  deps: Pick<CreateGenerationJobDeps, 'logger'>,
  kind: GenerationJobKind,
  context: { jobId?: string; ownerId: string },
  cleanup: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await cleanup();
  } catch (cleanupError) {
    deps.logger.error(`${kind}_job_create_cleanup_failed`, { ...context, error: cleanupError });
    return undefined;
  }
}

type FailedCreate<K extends GenerationJobKind> = { kind: K; jobId: string; job: NewGenerationJob<K> };

type CreateRecovery<K extends GenerationJobKind> =
  | { outcome: 'landed'; job: IGenerationJobDocumentOf<K> }
  | { outcome: 'replay'; result: CreatedJob<K> | IdempotencyKeyReused }
  | { outcome: 'failed' };

/**
 * A createJob error is ambiguous: the insert may have landed before it (a lost ack, a driver retry that then hit
 * the idempotency index). The caller-generated id makes the outcome checkable, and the hold follows the job:
 * - our insert landed: the job owns the hold and is enqueued as usual, so the caller gets its success;
 * - another request holds the idempotency key: no job carries our hold, so release it and replay the winner;
 * - confirmed absent: release the hold and fail;
 * - unknown (the lookup failed): keep the hold and alarm, since refunding a job that exists would mint credits.
 */
async function recoverFailedCreate<K extends GenerationJobKind>(
  error: unknown,
  failed: FailedCreate<K>,
  deps: CreateGenerationJobDeps
): Promise<CreateRecovery<K>> {
  const { kind } = failed;
  const { idempotencyKey, ownerId, creditHold } = failed.job;
  if (idempotencyKey && isDuplicateKeyError(error)) {
    const winner = await findKeyHolder(failed, idempotencyKey, deps);
    if (winner?.id === failed.jobId) return { outcome: 'landed', job: expectKind(winner, kind) };
    if (winner) {
      await releaseHold(failed, deps);
      return { outcome: 'replay', result: replayOrReject(winner, kind, failed.job.payload.request) };
    }
  }

  let landed: IGenerationJobDocument | null;
  try {
    landed = await deps.repository.findById(failed.jobId);
  } catch (lookupError) {
    deps.logger.error(`${kind}_job_create_ambiguous`, {
      jobId: failed.jobId,
      ownerId,
      reservedCredits: creditHold?.reservedCredits ?? 0,
      error: lookupError,
    });
    return { outcome: 'failed' };
  }
  if (landed) return { outcome: 'landed', job: expectKind(landed, kind) };
  await releaseHold(failed, deps);
  return { outcome: 'failed' };
}

// A failed lookup falls back to resolving the create by its id, which decides who owns the hold either way.
async function findKeyHolder<K extends GenerationJobKind>(
  failed: FailedCreate<K>,
  idempotencyKey: string,
  deps: CreateGenerationJobDeps
) {
  try {
    return await deps.repository.findByIdempotencyKey(failed.job.ownerType, failed.job.ownerId, idempotencyKey);
  } catch (lookupError) {
    deps.logger.warn(`${failed.kind} job idempotency key lookup failed`, {
      jobId: failed.jobId,
      error: lookupError,
    });
    return null;
  }
}

async function releaseHold<K extends GenerationJobKind>(
  { kind, job, jobId }: FailedCreate<K>,
  deps: CreateGenerationJobDeps
) {
  const hold = job.creditHold;
  if (!hold) return;
  await runCleanup(deps, kind, { jobId, ownerId: job.ownerId }, () => releaseCreditHold(hold, deps.credits));
}
