import { assertMediaModelAdmission } from '@server/billing/assertMediaModelAdmission';
import { Resource } from 'sst';
import { apiKeyService } from '@bike4mind/auth';
import {
  ApiKeyType,
  hasStorageUsage,
  isImageServeable,
  isPlaceholderApiKey,
  isStorageLimitError,
  type IGenerationJobDocument,
  type IGenerationJobUpdatedAction,
  type MusicProviderId,
  type VideoProviderId,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  fabFileRepository,
  generationJobRepository,
  organizationRepository,
  questRepository,
  sessionRepository,
  usageEventRepository,
  userRepository,
  newAccountSpendCapAdapters,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { modelDiscoveryService } from '@bike4mind/services';
import { GenerationJobEngine } from '@bike4mind/services/generationJobs';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import { createMusicJobHandler, type CreateMusicJobDeps, type MusicJobDeps } from '@bike4mind/services/musicJobs';
import {
  callerOwnsGeneratedImage,
  createVideoJobHandler,
  type CreateVideoJobDeps,
  type VideoJobDeps,
} from '@bike4mind/services/videoJobs';
import {
  checkStorageLimit,
  ClientMessageSender,
  getSettingsByNames,
  getSettingsMap,
  getSettingsValue,
} from '@bike4mind/utils';
import {
  createMusicProviderRegistry,
  ElevenLabsMusicProvider,
  LyriaMusicProvider,
  TestMusicProvider,
  type MusicProvider,
} from '@bike4mind/utils/musicProviders';
import {
  createVideoProviderRegistry,
  GeminiOmniVideoProvider,
  TestVideoProvider,
  VeoVideoProvider,
  XaiVideoProvider,
  type VideoProvider,
} from '@bike4mind/utils/videoProviders';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { saveGeneratedAssetToFiles } from '@bike4mind/server-utils/utils/saveGeneratedAssetToFiles';
import { deliverJobToSlack } from './slackJobDelivery';
import { createSlackJobDeliveryDeps } from './slackJobDeliveryDeps';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';

// Must outlive the worker timeout (5 min, infra/queues.ts generationJobQueue) so two workers never overlap on
// one job, and stay under the queue visibility timeout (6 min).
const LEASE_MS = 5 * 60_000 + 30_000;

const logger = new Logger({ metadata: { component: 'generationJobs' } });

/**
 * Maps the raw value of a provider key to one a provider call may use. getEffectiveLLMApiKeys answers an
 * expired per-user key with the expired-key sentinel (a truthy string, so it would otherwise reach the
 * provider as a bearer token); a missing or empty key is null or ''. A placeholder (your-api-key,
 * REPLACE_ME, ...) is no key either, as in modelDiscoveryService/credentials.ts: otherwise a
 * half-configured stage lists the model, holds credits and only fails after the submit retries.
 */
export const usableApiKey = (raw: string | null | undefined): string | null => {
  if (!raw || raw === modelDiscoveryService.EXPIRED_KEY_SENTINEL || isPlaceholderApiKey(raw)) return null;
  return raw;
};

/** Each provider adapter adds its case here; the exhaustive switch makes the compiler demand it. */
export const selectProviderKey = (
  providerId: VideoProviderId,
  keys: Awaited<ReturnType<typeof apiKeyService.getEffectiveLLMApiKeys>>
): string | null | undefined => {
  switch (providerId) {
    case 'test':
      return 'test-key';
    case 'gemini-omni':
    case 'veo':
      return keys.gemini;
    // The same key as xAI chat (user key, admin setting, then XAI_API_KEY).
    case 'xai':
      return keys.xai;
    default: {
      const unhandled: never = providerId;
      throw new Error(`no API key mapping for video provider '${String(unhandled)}'`);
    }
  }
};

type MusicProviderKeys = Awaited<ReturnType<typeof apiKeyService.getEffectiveLLMApiKeys>> & {
  elevenlabs?: string | null;
};

/** As selectProviderKey, for the music providers. */
export const selectMusicProviderKey = (
  providerId: MusicProviderId,
  keys: MusicProviderKeys
): string | null | undefined => {
  switch (providerId) {
    case 'test':
      return 'test-key';
    case 'gemini-lyria':
      return keys.gemini;
    case 'elevenlabs':
      return keys.elevenlabs;
    default: {
      const unhandled: never = providerId;
      throw new Error(`no API key mapping for music provider '${String(unhandled)}'`);
    }
  }
};

export const toJobUpdate = (job: IGenerationJobDocument): IGenerationJobUpdatedAction => {
  const { output } = job.payload;
  return {
    action: 'generation_job_updated',
    job: {
      id: job.id,
      kind: job.kind,
      state: job.state,
      ...(job.progress !== undefined && { progress: job.progress }),
      ...(job.error && { error: { code: job.error.code, message: job.error.message } }),
      ...(output && {
        output: {
          ...(output.fileId && { fileId: output.fileId }),
          contentType: output.contentType,
          durationSeconds: output.durationSeconds,
        },
      }),
    },
  };
};

// Gemini, xAI and Veo are registered everywhere; whether a caller can use one depends on a resolvable key
// (hasUsableKey in packages/server-utils/src/videoGenerations/listUsableVideoModels.ts).
export const buildProviders = (): VideoProvider[] => {
  const providers: VideoProvider[] = [new GeminiOmniVideoProvider(), new XaiVideoProvider(), new VeoVideoProvider()];
  // Set only on non-production stages by infra (TEST_GENERATION_PROVIDER_ENVIRONMENT); never registered in production.
  if (process.env.ENABLE_TEST_VIDEO_PROVIDER === 'true') providers.push(new TestVideoProvider());
  return providers;
};

// Lyria and ElevenLabs are registered everywhere; a caller can use one only with a resolvable key.
export const buildMusicProviders = (): MusicProvider[] => {
  const providers: MusicProvider[] = [new LyriaMusicProvider(), new ElevenLabsMusicProvider()];
  // Set only on non-production stages by infra (TEST_GENERATION_PROVIDER_ENVIRONMENT); never registered in production.
  if (process.env.ENABLE_TEST_MUSIC_PROVIDER === 'true') providers.push(new TestMusicProvider());
  return providers;
};

// Direct links (worker, sweep cron) win; API Lambdas only carry the sourceQueueUrls Linkable. sst's Resource
// proxy throws on an unlinked key, hence the try.
const resolveGenerationJobQueueUrl = (): string => {
  try {
    const directUrl = (Resource as unknown as { generationJobQueue?: { url?: string } }).generationJobQueue?.url;
    if (directUrl) return directUrl;
  } catch {
    // Not linked directly in this Lambda; fall through to the registry.
  }
  return getSourceQueueUrl('generationJobQueue');
};

// The engine skips a delivery that arrives early, so delaySeconds must reach SQS unchanged.
export const enqueueGenerationJob = async (jobId: string, delaySeconds: number): Promise<void> => {
  if (process.env.BYPASS_QUEUE === 'true') {
    // Local dev without SQS: run the step in-process after the delay.
    setTimeout(() => {
      getGenerationJobEngine()
        .step(jobId)
        .catch(error => logger.error('inline generation job step failed', { jobId, error }));
    }, delaySeconds * 1000);
    return;
  }
  await sendToQueue(resolveGenerationJobQueueUrl(), { jobId }, delaySeconds);
};

const effectiveKeys = (userId: string) =>
  apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { adminSettings: adminSettingsRepository, apiKeys: apiKeyRepository },
    getSettingsByNames,
  });

const resolveApiKey: VideoJobDeps['resolveApiKey'] = async (providerId, userId) =>
  usableApiKey(selectProviderKey(providerId, await effectiveKeys(userId)));

// getEffectiveLLMApiKeys carries no ElevenLabs key: it resolves like the TTS and music chat tools (user key, then
// the admin demo key), and is read only for an ElevenLabs job.
const musicProviderKeys = async (providerId: MusicProviderId, userId: string): Promise<MusicProviderKeys> => {
  const keys = await effectiveKeys(userId);
  if (providerId !== 'elevenlabs') return keys;
  const elevenlabs = await apiKeyService.getEffectiveApiKey(
    userId,
    { type: ApiKeyType.elevenlabs, nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );
  return { ...keys, elevenlabs };
};

const resolveMusicApiKey: MusicJobDeps['resolveApiKey'] = async (providerId, userId) =>
  usableApiKey(selectMusicProviderKey(providerId, await musicProviderKeys(providerId, userId)));

// Owner-only on purpose for both kinds: the image becomes provider input, and a shared image is not the
// requester's to send out.
export const loadInputImage: VideoJobDeps['loadInputImage'] = async (userId, ref) =>
  ref.kind === 'file' ? loadInputFabFile(userId, ref.id) : loadInputGeneratedImage(userId, ref.key);

const loadInputFabFile = async (userId: string, fileId: string) => {
  // The id is caller-supplied; a malformed one would throw a CastError from the query instead of reading as missing.
  if (!isValidObjectId(fileId)) return null;
  const fabFile = await fabFileRepository.findByIdAndUserId(fileId, userId);
  if (!fabFile || fabFile.deletedAt) return null;
  if (!fabFile.filePath || !fabFile.mimeType?.startsWith('image/')) return null;
  // Same upload moderation gate as every other FabFile read: a pending or blocked image is not sent to a provider.
  if (!isImageServeable(fabFile)) return null;
  const bytes = await getFilesStorage().download(fabFile.filePath);
  return { bytes, mimeType: fabFile.mimeType };
};

// Keyed by the extensions GENERATED_IMAGE_KEY_RE admits; callerOwnsGeneratedImage refuses any other key first.
const GENERATED_IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Same ownership rule as edit_image (callerOwnsGeneratedImage), and like edit_image no moderation gate
// here: this trusts that whatever wrote the key into quest.images moderated it (image_generation and
// edit_image do, before upload).
const loadInputGeneratedImage = async (userId: string, key: string) => {
  const lookup = { userId, quests: questRepository, sessions: sessionRepository, logger };
  if (!(await callerOwnsGeneratedImage(key, lookup))) return null;
  const mimeType = GENERATED_IMAGE_MIME_TYPES[key.slice(key.lastIndexOf('.') + 1)];
  if (!mimeType) return null;
  const bytes = await getGeneratedImageStorage().download(key);
  return { bytes, mimeType };
};

export const saveToFiles: MusicJobDeps['saveToFiles'] = async params => {
  if (!params.questId) return saveGeneratedAssetToFiles(params, logger);
  // Linked through the quest's notebook like every in-chat asset: the link scopes the grants that notebook mints and
  // lets the generated-copy fork guard tell the owning notebook apart. A notebook delete keeps the file.
  const sessionId = (await questRepository.findById(params.questId))?.sessionId;
  return saveGeneratedAssetToFiles({ ...params, ...(sessionId && { sessionId }) }, logger);
};

const saveToGeneratedBucket: VideoJobDeps['saveToGeneratedBucket'] = async ({ key, bytes, contentType, signal }) => {
  await getGeneratedImageStorage().upload(bytes, key, { ContentType: contentType }, signal);
  return { s3Key: key };
};

// Both are read once per job on a long-lived queue host, and decide whether the job debits, so
// they bypass the process cache (names lists must stay complete under skipCache).
const getSettings: VideoJobDeps['getSettings'] = async () => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits', 'videoGeneration'], skipCache: true }
  );
  return {
    enforceCredits: Boolean(getSettingsValue('enforceCredits', settings)),
    videoGeneration: getSettingsValue('videoGeneration', settings),
  };
};

const getMusicSettings: MusicJobDeps['getSettings'] = async () => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits', 'musicGeneration'], skipCache: true }
  );
  return {
    enforceCredits: Boolean(getSettingsValue('enforceCredits', settings)),
    musicGeneration: getSettingsValue('musicGeneration', settings),
  };
};

// The same per-user quota createFabFile enforces on the save (saveGeneratedAsset passes no organization).
export const checkStorageFor: CreateMusicJobDeps['checkStorageFor'] = async (userId, bytes) => {
  const user = await userRepository.findById(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  try {
    await checkStorageLimit(user, bytes);
    return undefined;
  } catch (error) {
    // checkStorageLimit on the user's own quota always carries the byte counts.
    if (isStorageLimitError(error) && hasStorageUsage(error.info)) return error.info;
    throw error;
  }
};

const recordMusicUsage: MusicJobDeps['recordUsage'] = async ({
  job,
  creditsCharged,
  costUsd,
  durationSeconds,
  status,
}) => {
  try {
    await usageEventRepository.record({
      requestId: job.questId ?? job.id,
      userId: job.requestedBy,
      ownerId: job.ownerId,
      ownerType: job.ownerType,
      ...(job.payload.sessionId !== undefined && { sessionId: job.payload.sessionId }),
      feature: 'music_generation',
      provider: job.payload.providerId,
      model: job.payload.request.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: durationSeconds,
      costUsd,
      creditsCharged,
      status,
      latencyMs: Date.now() - (job.createdAt?.getTime() ?? Date.now()),
    });
  } catch (error) {
    // Analytics only, never billing: a lost row must not fail the job.
    logger.warn('failed to record music usage event', { jobId: job.id, error });
  }
};

const recordUsage: VideoJobDeps['recordUsage'] = async ({ job, creditsCharged, costUsd, durationSeconds, status }) => {
  try {
    await usageEventRepository.record({
      requestId: job.questId ?? job.id,
      userId: job.requestedBy,
      ownerId: job.ownerId,
      ownerType: job.ownerType,
      feature: 'video_generation',
      provider: job.payload.providerId,
      model: job.payload.request.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      units: durationSeconds,
      costUsd,
      creditsCharged,
      status,
      latencyMs: Date.now() - (job.createdAt?.getTime() ?? Date.now()),
    });
  } catch (error) {
    // Analytics only, never billing: a lost row must not fail the job.
    logger.warn('failed to record video usage event', { jobId: job.id, error });
  }
};

const notify = async (job: IGenerationJobDocument): Promise<void> => {
  const sender = new ClientMessageSender({ connections: Connection }, logger);
  // Independent channels: a websocket failure must not swallow the Slack post, nor the reverse.
  const results = await Promise.allSettled([
    sender.sendToClient(job.requestedBy, Resource.websocket.managementEndpoint, toJobUpdate(job)),
    deliverJobToSlack(job, createSlackJobDeliveryDeps(logger)),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
};

let videoJobDeps: VideoJobDeps | undefined;
export const getVideoJobDeps = (): VideoJobDeps => {
  videoJobDeps ??= {
    repository: generationJobRepository,
    providers: createVideoProviderRegistry(buildProviders()),
    getSettings,
    resolveApiKey,
    loadInputImage,
    saveToFiles,
    saveToGeneratedBucket,
    credits: {
      users: userRepository,
      organizations: organizationRepository,
      creditTransactions: creditTransactionRepository,
      newAccountSpendCap: newAccountSpendCapAdapters,
    },
    enqueue: enqueueGenerationJob,
    recordUsage,
    now: () => new Date(),
    logger,
  };
  return videoJobDeps;
};

export const getCreateVideoJobDeps = (): CreateVideoJobDeps => ({
  ...getVideoJobDeps(),
  assertModelAdmission: assertMediaModelAdmission,
  engine: getGenerationJobEngine(),
});

let musicJobDeps: MusicJobDeps | undefined;
export const getMusicJobDeps = (): MusicJobDeps => {
  musicJobDeps ??= {
    repository: generationJobRepository,
    providers: createMusicProviderRegistry(buildMusicProviders()),
    getSettings: getMusicSettings,
    resolveApiKey: resolveMusicApiKey,
    saveToFiles,
    saveToGeneratedBucket,
    credits: {
      users: userRepository,
      organizations: organizationRepository,
      creditTransactions: creditTransactionRepository,
      newAccountSpendCap: newAccountSpendCapAdapters,
    },
    enqueue: enqueueGenerationJob,
    recordUsage: recordMusicUsage,
    now: () => new Date(),
    logger,
  };
  return musicJobDeps;
};

export const getCreateMusicJobDeps = (): CreateMusicJobDeps => ({
  ...getMusicJobDeps(),
  assertModelAdmission: assertMediaModelAdmission,
  engine: getGenerationJobEngine(),
  checkStorageFor,
});

let generationJobEngine: GenerationJobEngine | undefined;
export const getGenerationJobEngine = (): GenerationJobEngine => {
  generationJobEngine ??= new GenerationJobEngine({
    repository: generationJobRepository,
    handlers: [createVideoJobHandler(getVideoJobDeps()), createMusicJobHandler(getMusicJobDeps())],
    enqueue: enqueueGenerationJob,
    notify,
    now: () => new Date(),
    logger,
    leaseMs: LEASE_MS,
    aiAccessDenial: async userId => {
      const user = await userRepository.findById(userId);
      return user ? aiAccessDeniedMessage(user) : 'User not found';
    },
  });
  return generationJobEngine;
};
