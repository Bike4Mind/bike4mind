import {
  DEFAULT_TTS_PROVIDER,
  estimateTtsHoldCredits,
  speechJobRequestSchema,
  TTS_DEFAULT_MODEL,
  TTS_MAX_INPUT_CHARS,
  ttsCandidates,
  VOICE_VENDOR_SUPPORTED_FORMATS,
  type StoredSpeechRequest,
  type VoiceGenerationVendor,
  type VoiceOutputFormat,
} from '@bike4mind/common';
import { isUsableApiKey } from '../generationJobs/apiKey';
import {
  findIdempotentReplay,
  holdJobCredits,
  persistAndEnqueueJob,
  resolveJobOwner,
} from '../generationJobs/createJob';
import {
  AUDIO_JOB_MAX_WALL_CLOCK_MS,
  type CreateSpeechJobDeps,
  type CreateSpeechJobInput,
  type CreateSpeechJobResult,
} from './types';

// The most a clip can take per input character, for the create-time storage check: uncompressed 24 kHz 16-bit audio
// at a slow ~12 characters a second, and a compressed format at a tenth of that.
const UNCOMPRESSED_FORMATS: readonly VoiceOutputFormat[] = ['wav', 'pcm', 'flac'];
const maxBytesPerCharacter = (format: VoiceOutputFormat | undefined) =>
  format && UNCOMPRESSED_FORMATS.includes(format) ? 4_000 : 400;

const invalid = (message: string): CreateSpeechJobResult => ({
  ok: false,
  status: 422,
  code: 'invalid_request',
  message,
});

/**
 * Validates a speech request, picks the vendors that may serve it, holds enough credits for the costliest of them
 * and persists + enqueues a pending speech job. Expected refusals are returned as values; a failure to persist or
 * enqueue throws (a 5xx for the caller) after returning the hold.
 */
export async function createSpeechJob(
  input: CreateSpeechJobInput,
  deps: CreateSpeechJobDeps
): Promise<CreateSpeechJobResult> {
  const parsed = speechJobRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, status: 400, code: 'invalid_request', message };
  }
  const vendor = parsed.data.provider ?? DEFAULT_TTS_PROVIDER;
  const request: StoredSpeechRequest = { ...parsed.data, provider: vendor };
  const { text, format } = request;

  const maxChars = TTS_MAX_INPUT_CHARS[vendor];
  if (text.length > maxChars) {
    return invalid(`Input exceeds the ${vendor} limit of ${maxChars} characters (got ${text.length})`);
  }
  // Checked up front so an unsupported (vendor, format) pair is refused before any provider cost.
  if (format && !VOICE_VENDOR_SUPPORTED_FORMATS[vendor].includes(format)) {
    return invalid(
      `The ${vendor} provider does not support the '${format}' output format ` +
        `(supported: ${VOICE_VENDOR_SUPPORTED_FORMATS[vendor].join(', ')})`
    );
  }

  const owner = resolveJobOwner(input.user);
  const replay = await findIdempotentReplay(
    { kind: 'speech', owner, idempotencyKey: input.idempotencyKey, request },
    deps
  );
  if (replay) return replay;
  await deps.assertModelAdmission(
    input.user.id,
    request.model ?? TTS_DEFAULT_MODEL[vendor],
    input.user.adminRoleWithheld
  );

  const candidates = await usableCandidates(input, request, deps);
  if (candidates.length === 0) {
    return { ok: false, status: 422, code: 'model_unavailable', message: 'No text-to-speech provider is configured' };
  }

  const saveToFiles = input.saveToFiles ?? true;
  if (saveToFiles) {
    const storage = await deps.checkStorageFor(input.user.id, text.length * maxBytesPerCharacter(format));
    if (storage) {
      return {
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        message: 'Not enough free file storage for this clip',
        storage,
      };
    }
  }

  const settings = await deps.getSettings();
  const held = await holdJobCredits(
    {
      enforceCredits: settings.enforceCredits,
      user: input.user,
      requiredCredits: estimateTtsHoldCredits(vendor, request.model, text.length, candidates),
      featureLabel: 'text-to-speech',
    },
    deps
  );
  if (!held.ok) return held;

  const now = deps.now();
  return persistAndEnqueueJob(
    'speech',
    {
      ...owner,
      requestedBy: input.user.id,
      ...(input.apiKeyId && { apiKeyId: input.apiKeyId }),
      source: input.source,
      state: 'pending',
      payload: {
        request,
        candidates,
        ...(input.preferredVoice && { preferredVoice: input.preferredVoice }),
        saveToFiles,
        ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      // Set at creation so the sweeper also recovers a job whose first queue message was lost.
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + AUDIO_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      creditHold: held.hold,
      questId: input.questId,
    },
    deps
  );
}

/**
 * The requested vendor when it has a usable key, then each alternate that accepts the text, has a usable key and
 * whose default model the user may use. A failed key lookup only drops that alternate.
 */
async function usableCandidates(
  input: CreateSpeechJobInput,
  request: StoredSpeechRequest,
  deps: CreateSpeechJobDeps
): Promise<VoiceGenerationVendor[]> {
  const { id: userId, adminRoleWithheld } = input.user;
  const checks = ttsCandidates(request.provider, request.text.length).map(async vendor => {
    if (!deps.providers[vendor]) return false;
    try {
      if (!isUsableApiKey(await deps.resolveApiKey(vendor, userId))) return false;
    } catch (error) {
      deps.logger.warn('TTS candidate key lookup failed', { vendor, error });
      return false;
    }
    return vendor === request.provider || deps.isModelAdmitted(userId, TTS_DEFAULT_MODEL[vendor], adminRoleWithheld);
  });
  const usable = await Promise.all(checks);
  return ttsCandidates(request.provider, request.text.length).filter((_vendor, index) => usable[index]);
}
