import {
  estimateMusicCostCredits,
  getMusicModelCapabilities,
  isMusicModelEnabled,
  MusicGenerationRequestSchema,
  validateMusicRequest,
  type MusicModelCapabilities,
  type StoredMusicRequest,
} from '@bike4mind/common';
import { isUsableApiKey } from '../generationJobs/apiKey';
import {
  findIdempotentReplay,
  holdJobCredits,
  persistAndEnqueueJob,
  resolveJobOwner,
} from '../generationJobs/createJob';
import {
  MAX_MUSIC_BYTES_PER_SECOND,
  MUSIC_JOB_MAX_WALL_CLOCK_MS,
  type CreateMusicJobDeps,
  type CreateMusicJobInput,
  type CreateMusicJobResult,
} from './types';

// An approximate model only steers length by the prompt, so the song can run to the model's maximum.
const storageSecondsFor = (caps: MusicModelCapabilities, request: StoredMusicRequest): number => {
  const { duration } = caps;
  if (duration.control === 'approximate') return duration.max;
  if (duration.control === 'fixed') return duration.seconds;
  return request.durationSeconds;
};

/**
 * Validates the request, holds the estimated credits and persists + enqueues a pending music job.
 * Expected refusals are returned as values; a failure to persist or enqueue throws (a 5xx for the caller)
 * after returning the hold.
 */
export async function createMusicJob(
  input: CreateMusicJobInput,
  deps: CreateMusicJobDeps
): Promise<CreateMusicJobResult> {
  const parsed = MusicGenerationRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, status: 400, code: 'invalid_request', message };
  }
  const caps = getMusicModelCapabilities(parsed.data.model);
  if (!deps.providers.get(caps.provider)) {
    return {
      ok: false,
      status: 422,
      code: 'model_unavailable',
      message: `${caps.displayName} is not available in this environment`,
    };
  }
  const settings = await deps.getSettings();
  if (!isMusicModelEnabled(parsed.data.model, settings.musicGeneration)) {
    return {
      ok: false,
      status: 403,
      code: 'model_disabled',
      message: `${caps.displayName} is disabled by your administrator`,
    };
  }
  const validation = validateMusicRequest(parsed.data, caps);
  if (!validation.ok) return { ok: false, status: 422, code: validation.code, message: validation.message };
  // Stored with its defaults resolved, so a replay compares (and the job bills) what was actually asked for.
  const request: StoredMusicRequest = validation.request;

  const owner = resolveJobOwner(input.user);
  const replay = await findIdempotentReplay(
    { kind: 'music', owner, idempotencyKey: input.idempotencyKey, request },
    deps
  );
  if (replay) return replay;
  // After the replay lookup so a same-key retry still gets its job once the key is gone.
  if (!isUsableApiKey(await deps.resolveApiKey(caps.provider, input.user.id))) {
    return {
      ok: false,
      status: 422,
      code: 'model_unavailable',
      message: `${caps.displayName} has no API key configured`,
    };
  }

  // Before the hold, so a full quota is refused up front rather than the song landing outside Files.
  const storage = await deps.checkStorageFor(
    input.user.id,
    storageSecondsFor(caps, request) * MAX_MUSIC_BYTES_PER_SECOND
  );
  if (storage) {
    return {
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'Not enough free file storage for this song',
      storage,
    };
  }

  const held = await holdJobCredits(
    {
      enforceCredits: settings.enforceCredits,
      user: input.user,
      requiredCredits: estimateMusicCostCredits(caps, request),
      featureLabel: 'music generation',
    },
    deps
  );
  if (!held.ok) return held;

  const now = deps.now();
  return persistAndEnqueueJob(
    'music',
    {
      ...owner,
      requestedBy: input.user.id,
      source: input.source,
      state: 'pending',
      payload: {
        request,
        providerId: caps.provider,
        ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      // Set at creation so the sweeper also recovers a job whose first queue message was lost.
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + MUSIC_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      creditHold: held.hold,
      questId: input.questId,
    },
    deps
  );
}
