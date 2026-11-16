import { apiKeyService } from '@bike4mind/auth';
import {
  ApiKeyType,
  type AudioJobOutput,
  type SoundGenerationVendor,
  type VoiceGenerationVendor,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  generationJobRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
  voiceRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { voiceService } from '@bike4mind/services';
import {
  createSoundEffectJob,
  createSpeechJob,
  type AudioJobDeps,
  type CreateSoundEffectJobDeps,
  type CreateSpeechJobDeps,
  type SoundEffectJobDeps,
  type SpeechJobDeps,
} from '@bike4mind/services/audioJobs';
import { runJobInline } from '@bike4mind/services/generationJobs';
import type { AudioToolJobs } from '@bike4mind/services/llm/tools';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  createSoundEffectProvider,
  createSpeechProvider,
  testSoundEffectProvider,
  testSpeechProvider,
} from '@bike4mind/utils/audioProviders';
import { assertMediaModelAdmission, isMediaModelAdmitted } from '../billing/assertMediaModelAdmission';
import { newAccountSpendCapAdaptersWithAlert } from '../billing/newAccountSpendCapWithAlert';
import { recordInsufficientCredits } from '../billing/userLimitEvents';
import { getFilesStorage, getGeneratedImageStorage } from '../utils/storage/index';
import {
  checkStorageFor,
  enqueueGenerationJob,
  getGenerationJobEngine,
  saveToFiles,
  saveToGeneratedBucket,
  usableApiKey,
} from './wiring';

const logger = new Logger({ metadata: { component: 'generationJobs' } });

// The stored key type each audio vendor needs; getEffectiveApiKey resolves the user's own key, then the admin one.
const AUDIO_VENDOR_KEY_TYPE: Record<VoiceGenerationVendor | SoundGenerationVendor, ApiKeyType> = {
  openai: ApiKeyType.openai,
  elevenlabs: ApiKeyType.elevenlabs,
};

const DEFAULT_OPENAI_VOICE = 'alloy';

const resolveAudioApiKey = async (
  vendor: VoiceGenerationVendor | SoundGenerationVendor,
  userId: string
): Promise<string | null> =>
  usableApiKey(
    await apiKeyService.getEffectiveApiKey(
      userId,
      { type: AUDIO_VENDOR_KEY_TYPE[vendor], nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    )
  );

/**
 * OpenAI: the requested voice, the user's preference, then the admin default. ElevenLabs: the requested voice, then
 * the user's active voice; undefined lets the service apply its premade default.
 */
const resolveSpeechVoice: SpeechJobDeps['resolveVoice'] = async ({
  vendor,
  userId,
  requestedVoice,
  preferredVoice,
}) => {
  if (requestedVoice) return requestedVoice;
  if (vendor === 'elevenlabs') {
    return (await voiceService.getVoiceId(userId, { db: { voices: voiceRepository } })) || undefined;
  }
  if (preferredVoice) return preferredVoice;
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['voiceSessionAiVoice'] });
  return getSettingsValue('voiceSessionAiVoice', settings) || DEFAULT_OPENAI_VOICE;
};

const getAudioSettings: AudioJobDeps['getSettings'] = async () => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits'], skipCache: true }
  );
  return { enforceCredits: Boolean(getSettingsValue('enforceCredits', settings)) };
};

const latencyMs = (createdAt: Date | undefined) => Date.now() - (createdAt?.getTime() ?? Date.now());

const recordSpeechUsage: SpeechJobDeps['recordUsage'] = async ({
  job,
  provider,
  model,
  characters,
  creditsCharged,
  costUsd,
}) => {
  try {
    await usageEventRepository.record({
      requestId: job.questId ?? job.id,
      userId: job.requestedBy,
      ownerId: job.ownerId,
      ownerType: job.ownerType,
      ...(job.payload.sessionId !== undefined && { sessionId: job.payload.sessionId }),
      feature: 'text_to_speech',
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: characters,
      costUsd,
      creditsCharged,
      status: 'ok',
      latencyMs: latencyMs(job.createdAt),
    });
  } catch (error) {
    // Analytics only, never billing: a lost row must not fail the job.
    logger.warn('failed to record speech usage event', { jobId: job.id, error });
  }
};

const recordSoundEffectUsage: SoundEffectJobDeps['recordUsage'] = async ({
  job,
  billedSeconds,
  creditsCharged,
  costUsd,
}) => {
  try {
    await usageEventRepository.record({
      requestId: job.questId ?? job.id,
      userId: job.requestedBy,
      ownerId: job.ownerId,
      ownerType: job.ownerType,
      ...(job.payload.sessionId !== undefined && { sessionId: job.payload.sessionId }),
      feature: 'sound_effects',
      provider: job.payload.providerId,
      model: job.payload.providerId,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: billedSeconds,
      costUsd,
      creditsCharged,
      status: 'ok',
      latencyMs: latencyMs(job.createdAt),
    });
  } catch (error) {
    logger.warn('failed to record sound effect usage event', { jobId: job.id, error });
  }
};

const baseDeps = (): AudioJobDeps => ({
  repository: generationJobRepository,
  getSettings: getAudioSettings,
  saveToFiles,
  saveToGeneratedBucket,
  credits: {
    users: userRepository,
    organizations: organizationRepository,
    creditTransactions: creditTransactionRepository,
    newAccountSpendCap: newAccountSpendCapAdaptersWithAlert,
    onInsufficientCredits: recordInsufficientCredits,
  },
  enqueue: enqueueGenerationJob,
  now: () => new Date(),
  logger,
});

// Set only on non-production stages by infra (TEST_GENERATION_PROVIDER_ENVIRONMENT); never registered in production.
// A test provider replaces the real one for its vendor, so a stage can exercise the job path without a key.
const testAudioProvidersEnabled = () => process.env.ENABLE_TEST_AUDIO_PROVIDER === 'true';

let speechJobDeps: SpeechJobDeps | undefined;
export const getSpeechJobDeps = (): SpeechJobDeps => {
  speechJobDeps ??= {
    ...baseDeps(),
    providers: testAudioProvidersEnabled()
      ? { openai: testSpeechProvider }
      : { openai: createSpeechProvider('openai'), elevenlabs: createSpeechProvider('elevenlabs') },
    resolveApiKey: testAudioProvidersEnabled() ? async () => 'test-key' : resolveAudioApiKey,
    resolveVoice: resolveSpeechVoice,
    recordUsage: recordSpeechUsage,
  };
  return speechJobDeps;
};

let soundEffectJobDeps: SoundEffectJobDeps | undefined;
export const getSoundEffectJobDeps = (): SoundEffectJobDeps => {
  soundEffectJobDeps ??= {
    ...baseDeps(),
    providers: testAudioProvidersEnabled()
      ? { elevenlabs: testSoundEffectProvider }
      : { elevenlabs: createSoundEffectProvider('elevenlabs') },
    resolveApiKey: testAudioProvidersEnabled() ? async () => 'test-key' : resolveAudioApiKey,
    recordUsage: recordSoundEffectUsage,
  };
  return soundEffectJobDeps;
};

export const getCreateSpeechJobDeps = (): CreateSpeechJobDeps => ({
  ...getSpeechJobDeps(),
  assertModelAdmission: assertMediaModelAdmission,
  isModelAdmitted: isMediaModelAdmitted,
  engine: getGenerationJobEngine(),
  checkStorageFor,
});

export const getCreateSoundEffectJobDeps = (): CreateSoundEffectJobDeps => ({
  ...getSoundEffectJobDeps(),
  assertModelAdmission: assertMediaModelAdmission,
  engine: getGenerationJobEngine(),
  checkStorageFor,
});

/**
 * Steps a just-created speech or sound-effect job in this process and waits for it to end (see runJobInline), for a
 * caller that answers synchronously. Null when it did not end in time; it then finishes, and bills, in the background.
 */
export const runAudioJobInline = (jobId: string, timeoutMs: number) =>
  runJobInline(
    jobId,
    { timeoutMs },
    { engine: getGenerationJobEngine(), repository: generationJobRepository, now: () => new Date() }
  );

/** The stored clip's bytes, from the Files or the generated bucket as the job recorded. */
export const readAudioJobOutput = (output: AudioJobOutput): Promise<Buffer> =>
  output.location === 'files'
    ? getFilesStorage().download(output.s3Key)
    : getGeneratedImageStorage().download(output.s3Key);

/** The audio_generation tool's job functions (ChatCompletionProcess `audioToolJobs`, agent tool config). */
export const buildAudioToolJobs = (): AudioToolJobs => ({
  createSpeechJob: input => createSpeechJob(input, getCreateSpeechJobDeps()),
  createSoundEffectJob: input => createSoundEffectJob(input, getCreateSoundEffectJobDeps()),
  runInline: runAudioJobInline,
  readOutput: readAudioJobOutput,
});
