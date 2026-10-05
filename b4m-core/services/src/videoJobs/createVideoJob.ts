import { isDeepStrictEqual } from 'node:util';
import {
  CreditHolderType,
  estimateVideoCostCredits,
  getQuestErrorCode,
  getVideoModelCapabilities,
  isVideoModelEnabled,
  validateAgainstCapabilities,
  VideoGenerationRequestSchema,
  type IGenerationJobDocument,
  type VideoGenerationRequest,
} from '@bike4mind/common';
import { holdCredits, releaseCreditHold, type CreditHold } from '../creditService/creditHold';
import {
  VIDEO_JOB_MAX_WALL_CLOCK_MS,
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
export async function createVideoJob(input: CreateVideoJobInput, deps: VideoJobDeps): Promise<CreateVideoJobResult> {
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
  let job: IGenerationJobDocument;
  try {
    job = await deps.repository.createJob({
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
    // A concurrent request with the same key won the unique index: no job carries this hold, so return it
    // and answer as the winner's replay.
    if (input.idempotencyKey && isDuplicateKeyError(error)) {
      if (hold) await runCleanup(deps, { ownerId }, () => releaseCreditHold(hold, deps.credits));
      const winner = await deps.repository.findByIdempotencyKey(ownerType, ownerId, input.idempotencyKey);
      if (winner) return replayOrReject(winner, request);
      throw error;
    }
    if (hold) await releaseIfJobAbsent(hold, { ownerType, ownerId, idempotencyKey: input.idempotencyKey }, deps);
    throw error;
  }

  try {
    await deps.enqueue(job.id, 0);
  } catch (error) {
    await runCleanup(deps, { jobId: job.id, ownerId }, () => failUnqueuedJob(job, hold, deps));
    throw error;
  }
  return { ok: true, job, created: true };
}

/** Runs a cleanup step on a path that is already failing, so its own error never masks the original one. */
async function runCleanup(
  deps: VideoJobDeps,
  context: { jobId?: string; ownerId: string },
  cleanup: () => Promise<void>
) {
  try {
    await cleanup();
  } catch (cleanupError) {
    deps.logger.error('video_job_create_cleanup_failed', { ...context, error: cleanupError });
  }
}

/**
 * A non-duplicate createJob error is ambiguous: the insert may have landed before the error (e.g. a lost ack).
 * If the job exists, its onTerminal owns the hold (the sweeper picks it up via nextPollAt), so releasing here
 * would refund twice. Release only when the job is confirmed absent; when that cannot be confirmed, keep the
 * hold and alarm for manual repair. Without an idempotency key there is no unique field to look the job up by.
 */
async function releaseIfJobAbsent(
  hold: CreditHold,
  lookup: { ownerType: CreditHold['ownerType']; ownerId: string; idempotencyKey?: string },
  deps: VideoJobDeps
) {
  const { ownerType, ownerId, idempotencyKey } = lookup;
  const reportAmbiguous = (lookupError?: unknown) =>
    deps.logger.error('video_job_create_ambiguous', {
      idempotencyKey,
      ownerId,
      reservedCredits: hold.reservedCredits,
      error: lookupError,
    });
  if (!idempotencyKey) {
    reportAmbiguous();
    return;
  }
  let landed: boolean;
  try {
    landed = (await deps.repository.findByIdempotencyKey(ownerType, ownerId, idempotencyKey)) !== null;
  } catch (lookupError) {
    reportAmbiguous(lookupError);
    return;
  }
  if (landed) return;
  await runCleanup(deps, { ownerId }, () => releaseCreditHold(hold, deps.credits));
}

const replayOrReject = (existing: IGenerationJobDocument, request: VideoGenerationRequest): CreateVideoJobResult =>
  isDeepStrictEqual(existing.payload.request, request)
    ? { ok: true, job: existing, created: false }
    : {
        ok: false,
        status: 422,
        code: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used with a different request',
      };

// The job never reached the queue, so nothing else will ever settle it: fail it and return the credits here.
async function failUnqueuedJob(job: IGenerationJobDocument, hold: CreditHold | null, deps: VideoJobDeps) {
  await deps.repository.commit(job.id, {
    state: 'failed',
    nextPollAt: null,
    error: { code: 'enqueue_failed', message: 'The job could not be queued' },
  });
  if (!(await deps.repository.claimTerminalHandling(job.id, deps.now()))) return;
  if (hold) await releaseCreditHold(hold, deps.credits);
  // Same settlement marker as the handler's onTerminal (videoJobHandler.ts).
  await deps.repository.commit(job.id, { settledCredits: 0 });
  await deps.repository.markTerminalHandled(job.id, deps.now());
}
