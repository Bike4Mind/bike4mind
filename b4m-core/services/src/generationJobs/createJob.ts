import { Types } from 'mongoose';
import {
  CreditHolderType,
  getQuestErrorCode,
  isGenerationJobOfKind,
  type GenerationJobCreateInput,
  type GenerationJobKind,
  type ApiKeyBillingOwnerType,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type IGenerationJobOf,
  type IGenerationJobRepository,
  type CompletionRunAttribution,
  type RunBudgetClaim,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { holdCredits, releaseCreditHold, type CreditHold, type CreditHoldAdapters } from '../creditService/creditHold';
import { assertSpendNotFrozen } from '../spendFreezeService/assertSpendNotFrozen';
import { spendFreezeSubjectForHold } from '../spendFreezeService/spendFreezeSubjectForHold';
import { checkNewAccountSpendCap } from '../creditService/newAccountSpendCap';
import type { GenerationJobEngine } from './engine';
import type { RunBudgetAdapters } from './types';

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
  /** Required for a job created with a `run`; see holdJobCredits. */
  runBudget?: RunBudgetAdapters;
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

const insufficientCredits = (message: string): InsufficientCredits => ({
  ok: false,
  status: 402,
  code: 'insufficient_credits',
  message,
});

export type HeldJobCredits = { ok: true; hold: CreditHold | null; runClaim?: RunBudgetClaim };

type HoldJobCreditsParams = {
  enforceCredits: boolean;
  user: { id: string; organizationId: string | null };
  requiredCredits: number;
  featureLabel: string;
  apiKeyId?: string | null;
  apiKeyBillingOwnerType?: ApiKeyBillingOwnerType | null;
  /** The completion run the job is made for: the whole hold is claimed against its budget, all or nothing. */
  run?: CompletionRunAttribution;
};

/**
 * Holds `requiredCredits` when credits are enforced; null when they are not. Insufficient credits is a value.
 * A frozen subject is refused even when credits are not enforced, and throws the 403 `spend_frozen` error
 * rather than returning a value: it is not a 402 the caller can recover from by buying credits.
 * With a `run`, the claim is taken first and in the hold's transaction: a refused claim (a thrown 422
 * `run_budget_exhausted`) holds nothing, and a hold that throws rolls the claim back. A refused hold returns
 * its claim before the transaction commits.
 */
export async function holdJobCredits(
  params: HoldJobCreditsParams,
  deps: Pick<CreateGenerationJobDeps, 'credits' | 'logger' | 'runBudget'>
): Promise<HeldJobCredits | InsufficientCredits> {
  if (!params.enforceCredits) {
    // holdCredits checks the freeze itself, so only the credits-off path needs it here.
    const subject = spendFreezeSubjectForHold({
      userId: params.user.id,
      organizationId: params.user.organizationId,
      apiKeyId: params.apiKeyId,
    });
    await assertSpendNotFrozen(subject, { db: { spendFreezes: deps.credits.spendFreezes } });
    return { ok: true, hold: null };
  }
  const { run } = params;
  if (!run) return holdOnly(params, deps);
  const runBudget = deps.runBudget;
  if (!runBudget) throw new Error('A job with a run needs run budget adapters (CreateGenerationJobDeps.runBudget)');
  return runBudget.transact(async () => {
    const runClaim = await runBudget.claim(run.runId, params.requiredCredits);
    const held = await holdOnly(params, deps);
    if (!held.ok) {
      if (runClaim) await runBudget.release(runClaim, 0);
      return held;
    }
    return runClaim ? { ...held, runClaim } : held;
  });
}

async function holdOnly(
  params: HoldJobCreditsParams,
  deps: Pick<CreateGenerationJobDeps, 'credits' | 'logger'>
): Promise<HeldJobCredits | InsufficientCredits> {
  try {
    const hold = await holdCredits(
      {
        userId: params.user.id,
        organizationId: params.user.organizationId,
        requiredCredits: params.requiredCredits,
        featureLabel: params.featureLabel,
        logger: deps.logger,
        apiKeyId: params.apiKeyId,
        apiKeyBillingOwnerType: params.apiKeyBillingOwnerType,
      },
      deps.credits
    );
    return { ok: true, hold };
  } catch (error) {
    if (getQuestErrorCode(error) === 'insufficient_credits' && error instanceof Error) {
      return insufficientCredits(error.message);
    }
    throw error;
  }
}

/**
 * Checks a multi-job batch's total against the new-account spend cap before its per-job holds. Refuses with
 * holdJobCredits' shape.
 */
export async function checkBatchSpendCap(
  params: {
    enforceCredits: boolean;
    user: { id: string; organizationId: string | null };
    totalCredits: number;
  },
  deps: Pick<CreateGenerationJobDeps, 'credits' | 'logger'>
): Promise<InsufficientCredits | null> {
  if (!params.enforceCredits || params.totalCredits <= 0) return null;
  const user = await deps.credits.users.findById(params.user.id);
  // holdCredits refuses a missing user on the first hold; nothing to cap here.
  if (!user) return null;
  const message = await checkNewAccountSpendCap(
    {
      user,
      requestedCredits: params.totalCredits,
      billedToOrganization: resolveJobOwner(params.user).ownerType === CreditHolderType.Organization,
      logger: deps.logger,
    },
    deps.credits.newAccountSpendCap
  );
  return message ? insufficientCredits(message) : null;
}

/**
 * The job to create, without its kind (a separate argument) and timestamps. Distributive over K, so a union of
 * kinds yields a union of per-kind jobs rather than one Omit that collapses their payloads.
 */
export type NewGenerationJob<K extends GenerationJobKind> = K extends GenerationJobKind
  ? Omit<IGenerationJobOf<K>, 'kind' | 'createdAt' | 'updatedAt'>
  : never;

/**
 * Persists a pending job that already owns `job.creditHold` (and its `runClaim`) and enqueues its first step. A
 * failure to persist or enqueue throws (a 5xx for the caller) after returning the hold and the claim; a lost
 * idempotency race replays the winner. An enqueue failure returns them through the engine's terminal settlement.
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
  const { creditHold: hold, runClaim } = job;
  const context = { jobId, ownerId: job.ownerId };
  if (hold) await runCleanup(deps, kind, context, () => releaseCreditHold(hold, deps.credits));
  if (!runClaim) return;
  await runCleanup(deps, kind, context, async () => {
    if (!deps.runBudget) throw new Error('No run budget adapters to release the run claim');
    await deps.runBudget.release(runClaim, 0);
  });
}
