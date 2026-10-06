import { Types } from 'mongoose';
import {
  CreditHolderType,
  estimateVideoCostCredits,
  getQuestErrorCode,
  getVideoModelCapabilities,
  isVideoModelEnabled,
  validateAgainstCapabilities,
  VideoGenerationRequestSchema,
  type IGenerationJob,
  type IGenerationJobDocument,
  type VideoGenerationRequest,
} from '@bike4mind/common';
import { holdCredits, releaseCreditHold, type CreditHold } from '../creditService/creditHold';
import {
  VIDEO_JOB_MAX_WALL_CLOCK_MS,
  type CreateVideoJobDeps,
  type CreateVideoJobInput,
  type CreateVideoJobResult,
  type VideoJobDeps,
} from './types';

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

/**
 * Validates the request, holds the estimated credits and persists + enqueues a pending video job.
 * Expected refusals are returned as values; a failure to persist or enqueue throws (a 5xx for the caller)
 * after returning the hold.
 */
export async function createVideoJob(
  input: CreateVideoJobInput,
  deps: CreateVideoJobDeps
): Promise<CreateVideoJobResult> {
  const parsed = VideoGenerationRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, status: 400, code: 'invalid_request', message };
  }
  const request = parsed.data;
  const caps = getVideoModelCapabilities(request.model);
  if (!deps.providers.get(caps.provider)) {
    return {
      ok: false,
      status: 422,
      code: 'model_unavailable',
      message: `${caps.displayName} is not available in this environment`,
    };
  }
  const settings = await deps.getSettings();
  if (!isVideoModelEnabled(request.model, settings.videoGeneration)) {
    return {
      ok: false,
      status: 403,
      code: 'model_disabled',
      message: `${caps.displayName} is disabled by your administrator`,
    };
  }
  const validation = validateAgainstCapabilities(request, caps);
  if (!validation.ok) return { ok: false, status: 422, code: validation.code, message: validation.message };

  // Fails fast on someone else's (or a missing) file; the handler loads it again at submit.
  if (request.mode === 'image_to_video' && request.inputImageFileId) {
    const image = await deps.loadInputImage(input.user.id, request.inputImageFileId);
    if (!image) return { ok: false, status: 404, code: 'input_image_not_found', message: 'Input image not found' };
  }

  const ownerType = input.user.organizationId ? CreditHolderType.Organization : CreditHolderType.User;
  const ownerId = input.user.organizationId ?? input.user.id;
  if (input.idempotencyKey) {
    const existing = await deps.repository.findByIdempotencyKey(ownerType, ownerId, input.idempotencyKey);
    if (existing) return replayOrReject(existing, request);
  }

  let hold: CreditHold | null = null;
  if (settings.enforceCredits) {
    try {
      hold = await holdCredits(
        {
          userId: input.user.id,
          organizationId: input.user.organizationId,
          requiredCredits: estimateVideoCostCredits(caps, request),
          featureLabel: 'video generation',
        },
        deps.credits
      );
    } catch (error) {
      if (getQuestErrorCode(error) === 'insufficient_credits' && error instanceof Error) {
        return { ok: false, status: 402, code: 'insufficient_credits', message: error.message };
      }
      throw error;
    }
  }

  const now = deps.now();
  const jobId = new Types.ObjectId().toHexString();
  let job: IGenerationJobDocument;
  try {
    job = await deps.repository.createJob({
      id: jobId,
      kind: 'video',
      ownerType,
      ownerId,
      requestedBy: input.user.id,
      source: input.source,
      state: 'pending',
      payload: { request, providerId: caps.provider },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      // Set at creation so the sweeper also recovers a job whose first queue message was lost.
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + VIDEO_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      creditHold: hold,
      questId: input.questId,
    });
  } catch (error) {
    const failed: FailedCreate = { jobId, ownerType, ownerId, idempotencyKey: input.idempotencyKey, hold, request };
    const recovery = await recoverFailedCreate(error, failed, deps);
    if (recovery.outcome === 'replay') return recovery.result;
    if (recovery.outcome === 'failed') throw error;
    job = recovery.job;
  }

  try {
    await deps.enqueue(job.id, 0);
  } catch (error) {
    // No message will reach the job, so fail it and return its hold here, unless a worker already started it:
    // then the send landed despite the error and the job is live.
    const outcome = await runCleanup(deps, { jobId: job.id, ownerId }, () =>
      deps.engine.failBeforeStart(job.id, { code: 'enqueue_failed', message: 'The job could not be queued' })
    );
    if (outcome !== 'skipped') throw error;
  }
  return { ok: true, job, created: true };
}

/** Runs a cleanup step on a path that is already failing, so its own error never masks the original one. */
async function runCleanup<T>(
  deps: VideoJobDeps,
  context: { jobId?: string; ownerId: string },
  cleanup: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await cleanup();
  } catch (cleanupError) {
    deps.logger.error('video_job_create_cleanup_failed', { ...context, error: cleanupError });
    return undefined;
  }
}

type FailedCreate = {
  jobId: string;
  ownerType: IGenerationJob['ownerType'];
  ownerId: string;
  idempotencyKey: string | undefined;
  hold: CreditHold | null;
  request: VideoGenerationRequest;
};

type CreateRecovery =
  | { outcome: 'landed'; job: IGenerationJobDocument }
  | { outcome: 'replay'; result: CreateVideoJobResult }
  | { outcome: 'failed' };

/**
 * A createJob error is ambiguous: the insert may have landed before it (a lost ack, a driver retry that then hit
 * the idempotency index). The caller-generated id makes the outcome checkable, and the hold follows the job:
 * - our insert landed: the job owns the hold and is enqueued as usual, so the caller gets its success;
 * - another request holds the idempotency key: no job carries our hold, so release it and replay the winner;
 * - confirmed absent: release the hold and fail;
 * - unknown (the lookup failed): keep the hold and alarm, since refunding a job that exists would mint credits.
 */
async function recoverFailedCreate(error: unknown, failed: FailedCreate, deps: VideoJobDeps): Promise<CreateRecovery> {
  if (failed.idempotencyKey && isDuplicateKeyError(error)) {
    const winner = await findKeyHolder(failed, failed.idempotencyKey, deps);
    if (winner?.id === failed.jobId) return { outcome: 'landed', job: winner };
    if (winner) {
      await releaseHold(failed, deps);
      return { outcome: 'replay', result: replayOrReject(winner, failed.request) };
    }
  }

  let landed: IGenerationJobDocument | null;
  try {
    landed = await deps.repository.findById(failed.jobId);
  } catch (lookupError) {
    deps.logger.error('video_job_create_ambiguous', {
      jobId: failed.jobId,
      ownerId: failed.ownerId,
      reservedCredits: failed.hold?.reservedCredits ?? 0,
      error: lookupError,
    });
    return { outcome: 'failed' };
  }
  if (landed) return { outcome: 'landed', job: landed };
  await releaseHold(failed, deps);
  return { outcome: 'failed' };
}

// A failed lookup falls back to resolving the create by its id, which decides who owns the hold either way.
async function findKeyHolder(failed: FailedCreate, idempotencyKey: string, deps: VideoJobDeps) {
  try {
    return await deps.repository.findByIdempotencyKey(failed.ownerType, failed.ownerId, idempotencyKey);
  } catch (lookupError) {
    deps.logger.warn('video job idempotency key lookup failed', { jobId: failed.jobId, error: lookupError });
    return null;
  }
}

async function releaseHold({ hold, jobId, ownerId }: FailedCreate, deps: VideoJobDeps) {
  if (!hold) return;
  await runCleanup(deps, { jobId, ownerId }, () => releaseCreditHold(hold, deps.credits));
}

// Key-sorted JSON, so the comparison matches what survives a Mongo round trip: an undefined field equals an
// absent one, and key order is irrelevant.
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested
  );

const replayOrReject = (existing: IGenerationJobDocument, request: VideoGenerationRequest): CreateVideoJobResult =>
  canonicalJson(existing.payload.request) === canonicalJson(request)
    ? { ok: true, job: existing, created: false }
    : {
        ok: false,
        status: 422,
        code: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used with a different request',
      };
