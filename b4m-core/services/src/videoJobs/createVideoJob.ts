import {
  estimateVideoCostCredits,
  getVideoModelCapabilities,
  isVideoModelEnabled,
  validateAgainstCapabilities,
  VideoGenerationRequestSchema,
  videoInputImageRef,
} from '@bike4mind/common';
import {
  findIdempotentReplay,
  holdJobCredits,
  persistAndEnqueueJob,
  resolveJobOwner,
} from '../generationJobs/createJob';
import {
  isUsableApiKey,
  VIDEO_JOB_MAX_WALL_CLOCK_MS,
  type CreateVideoJobDeps,
  type CreateVideoJobInput,
  type CreateVideoJobResult,
} from './types';

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

  // Fails fast on someone else's (or a missing) image; the handler loads it again at submit.
  const inputImage = request.mode === 'image_to_video' ? videoInputImageRef(request) : null;
  if (inputImage) {
    const image = await deps.loadInputImage(input.user.id, inputImage);
    if (!image) return { ok: false, status: 404, code: 'input_image_not_found', message: 'Input image not found' };
  }

  const owner = resolveJobOwner(input.user);
  const replay = await findIdempotentReplay(
    { kind: 'video', owner, idempotencyKey: input.idempotencyKey, request },
    deps
  );
  if (replay) return replay;
  // After the replay lookup so a same-key retry still gets its job once the key is gone; otherwise a keyless
  // provider would hold credits for a job that can only fail at submit.
  if (!isUsableApiKey(await deps.resolveApiKey(caps.provider, input.user.id))) {
    return {
      ok: false,
      status: 422,
      code: 'model_unavailable',
      message: `${caps.displayName} has no API key configured`,
    };
  }

  const held = await holdJobCredits(
    {
      enforceCredits: settings.enforceCredits,
      user: input.user,
      requiredCredits: estimateVideoCostCredits(caps, request),
      featureLabel: 'video generation',
    },
    deps
  );
  if (!held.ok) return held;

  const now = deps.now();
  return persistAndEnqueueJob(
    'video',
    {
      ...owner,
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
      creditHold: held.hold,
      questId: input.questId,
    },
    deps
  );
}
