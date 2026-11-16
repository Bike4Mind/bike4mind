import {
  DEFAULT_SOUND_MODEL_ID,
  isSupportedElevenLabsFormat,
  soundEffectJobRequestSchema,
  type SoundGenerationVendor,
  type StoredSoundEffectRequest,
} from '@bike4mind/common';
import { isUsableApiKey } from '../generationJobs/apiKey';
import {
  findIdempotentReplay,
  holdJobCredits,
  persistAndEnqueueJob,
  resolveJobOwner,
} from '../generationJobs/createJob';
import { dailyLimitRefusal, fullFilesQuota } from './shared';
import { estimateSoundCredits } from '../soundCost';
import {
  AUDIO_JOB_MAX_WALL_CLOCK_MS,
  type CreateSoundEffectJobDeps,
  type CreateSoundEffectJobInput,
  type CreateSoundEffectJobResult,
} from './types';

// Each vendor's output-format check, run before the hold: an unmapped codec would be generated and billed, then
// could be neither labelled nor saved.
const SUPPORTS_OUTPUT_FORMAT: Record<SoundGenerationVendor, (format: string) => boolean> = {
  elevenlabs: isSupportedElevenLabsFormat,
};

/**
 * Validates a sound-effect request, holds its duration-driven cost and persists + enqueues a pending job. Expected
 * refusals are returned as values; a failure to persist or enqueue throws after returning the hold.
 */
export async function createSoundEffectJob(
  input: CreateSoundEffectJobInput,
  deps: CreateSoundEffectJobDeps
): Promise<CreateSoundEffectJobResult> {
  const parsed = soundEffectJobRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, status: 400, code: 'invalid_request', message };
  }
  const request: StoredSoundEffectRequest = parsed.data;
  const { provider, format } = request;
  // An empty string is checked too: the generator keeps it, so it would otherwise fail only after the hold.
  if (format !== undefined && !SUPPORTS_OUTPUT_FORMAT[provider](format)) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_request',
      message: `The ${provider} provider does not support the '${format}' output format`,
    };
  }
  if (!deps.providers[provider]) {
    return { ok: false, status: 422, code: 'model_unavailable', message: `${provider} is not available here` };
  }

  const owner = resolveJobOwner(input.user);
  const replay = await findIdempotentReplay(
    { kind: 'sound_effect', owner, idempotencyKey: input.idempotencyKey, request },
    deps
  );
  if (replay) return replay;
  await deps.assertModelAdmission(input.user.id, DEFAULT_SOUND_MODEL_ID, input.user.adminRoleWithheld);
  if (!isUsableApiKey(await deps.resolveApiKey(provider, input.user.id))) {
    return { ok: false, status: 422, code: 'model_unavailable', message: `No ${provider} API key configured` };
  }

  const saveToFiles = input.saveToFiles ?? true;
  if (saveToFiles) {
    const storage = await fullFilesQuota(input.user.id, deps);
    if (storage) {
      return {
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        message: 'Not enough free file storage for this sound effect',
        storage,
      };
    }
  }

  const settings = await deps.getSettings();
  const capped = await dailyLimitRefusal(input.user, settings.enforceCredits, deps);
  if (capped) return capped;
  const held = await holdJobCredits(
    {
      enforceCredits: settings.enforceCredits,
      user: input.user,
      requiredCredits: estimateSoundCredits(provider, { durationSeconds: request.durationSeconds }).requiredCredits,
      featureLabel: 'sound generation',
    },
    deps
  );
  if (!held.ok) return held;

  const now = deps.now();
  return persistAndEnqueueJob(
    'sound_effect',
    {
      ...owner,
      requestedBy: input.user.id,
      ...(input.apiKeyId && { apiKeyId: input.apiKeyId }),
      source: input.source,
      state: 'pending',
      payload: {
        request,
        providerId: provider,
        saveToFiles,
        ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
        ...(input.usageSource && { usageSource: input.usageSource }),
      },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + AUDIO_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      creditHold: held.hold,
      questId: input.questId,
    },
    deps
  );
}
