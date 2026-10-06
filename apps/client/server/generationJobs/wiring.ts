import { Resource } from 'sst';
import { apiKeyService } from '@bike4mind/auth';
import {
  isImageServeable,
  isPlaceholderApiKey,
  KnowledgeType,
  videoFileExtension,
  type IGenerationJobDocument,
  type IGenerationJobUpdatedAction,
  type VideoProviderId,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  apiKeyRepository,
  Connection,
  creditTransactionRepository,
  dataLakeRepository,
  FabFile,
  fabFileRepository,
  generationJobRepository,
  organizationRepository,
  scopedSettingsRepository,
  usageEventRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { fabFilesService, modelDiscoveryService } from '@bike4mind/services';
import { GenerationJobEngine } from '@bike4mind/services/generationJobs';
import { createVideoJobHandler, type CreateVideoJobDeps, type VideoJobDeps } from '@bike4mind/services/videoJobs';
import { ClientMessageSender, getSettingsByNames, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  createVideoProviderRegistry,
  GeminiOmniVideoProvider,
  TestVideoProvider,
  XaiVideoProvider,
  type VideoProvider,
} from '@bike4mind/utils/videoProviders';
import { isValidObjectId } from '@server/utils/objectId';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';

// Must outlive the worker timeout (5 min, infra/queues.ts generationJobQueue) so two workers never overlap on
// one job, and stay under the queue visibility timeout (6 min).
const LEASE_MS = 5 * 60_000 + 30_000;

const logger = new Logger({ metadata: { component: 'generationJobs' } });

// createFabFile reports the storage quota and the per-file cap only through BadRequestError messages.
const SAVE_FAILURE_PATTERNS = {
  storage_limit: /storage limit/i,
  file_too_large: /maximum file size/i,
} as const;

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

// Gemini and xAI are registered everywhere; whether a caller can use one depends on a resolvable key
// (hasUsableKey in server/videoGenerations/listUsableVideoModels.ts).
export const buildProviders = (): VideoProvider[] => {
  const providers: VideoProvider[] = [new GeminiOmniVideoProvider(), new XaiVideoProvider()];
  // Set only on non-production stages by infra (TEST_VIDEO_PROVIDER_ENVIRONMENT); never registered in production.
  if (process.env.ENABLE_TEST_VIDEO_PROVIDER === 'true') providers.push(new TestVideoProvider());
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

const resolveApiKey: VideoJobDeps['resolveApiKey'] = async (providerId, userId) => {
  const keys = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { adminSettings: adminSettingsRepository, apiKeys: apiKeyRepository },
    getSettingsByNames,
  });
  return usableApiKey(selectProviderKey(providerId, keys));
};

// Owner-only on purpose: the image becomes provider input, and a shared file is not the requester's to send out.
export const loadInputImage: VideoJobDeps['loadInputImage'] = async (userId, fileId) => {
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

export const saveToFiles: VideoJobDeps['saveToFiles'] = async ({ userId, jobId, bytes, contentType, signal }) => {
  const jobTag = `job:${jobId}`;
  // A re-run after a lost commit must not store a second copy.
  const existing = await fabFileRepository.findOne({
    userId,
    deletedAt: null,
    tags: { $elemMatch: { name: jobTag } },
  });
  if (existing?.filePath) return { saved: true, fileId: existing.id, s3Key: existing.filePath };

  const extension = videoFileExtension(contentType);
  if (!extension) {
    logger.error('provider returned a non-video content type', { jobId, contentType });
    return { saved: false, reason: 'error' };
  }

  try {
    const created = await fabFilesService.createFabFile(
      userId,
      {
        type: KnowledgeType.VIDEO,
        fileName: `video-${jobId}.${extension}`,
        mimeType: contentType,
        contentType,
        fileSize: bytes.length,
        content: bytes,
        prefix: 'generated-video',
        tags: [
          { name: 'generated', strength: 1 },
          { name: 'video', strength: 1 },
          { name: jobTag, strength: 1 },
        ],
      },
      {
        db: {
          adminSettings: adminSettingsRepository,
          scopedSettings: scopedSettingsRepository,
          fabFiles: FabFile,
          users: User,
          dataLakes: dataLakeRepository,
        },
        storage: {
          upload: (path, content, options) =>
            getFilesStorage().upload(content, path, { ContentType: options?.ContentType || contentType }, signal),
          generateSignedUrl: (path, expireInSeconds, type) =>
            getFilesStorage().getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
        },
        // The type is the provider's, narrowed to a supported video above; the extension map does not list video
        // containers (user uploads stay closed), so an extension-first lookup would refuse every clip.
        mimeTypePrecedence: 'claim-first',
      }
    );
    if (!created.filePath) {
      logger.error('created video file has no storage path', { jobId, fileId: created.id });
      return { saved: false, reason: 'error' };
    }
    return { saved: true, fileId: created.id, s3Key: created.filePath };
  } catch (error) {
    // An aborted step must fail the step (and be retried), not fall back to the generated bucket.
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : '';
    if (SAVE_FAILURE_PATTERNS.storage_limit.test(message)) return { saved: false, reason: 'storage_limit' };
    if (SAVE_FAILURE_PATTERNS.file_too_large.test(message)) return { saved: false, reason: 'file_too_large' };
    logger.error('failed to save generated video to files', { jobId, error });
    return { saved: false, reason: 'error' };
  }
};

const saveToGeneratedBucket: VideoJobDeps['saveToGeneratedBucket'] = async ({ key, bytes, contentType, signal }) => {
  await getGeneratedImageStorage().upload(bytes, key, { ContentType: contentType }, signal);
  return { s3Key: key };
};

const getSettings: VideoJobDeps['getSettings'] = async () => {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  return {
    enforceCredits: Boolean(getSettingsValue('enforceCredits', settings)),
    videoGeneration: getSettingsValue('videoGeneration', settings),
  };
};

const recordUsage: VideoJobDeps['recordUsage'] = async ({ job, creditsCharged, costUsd, durationSeconds }) => {
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
      status: 'ok',
      latencyMs: Date.now() - (job.createdAt?.getTime() ?? Date.now()),
    });
  } catch (error) {
    // Analytics only, never billing: a lost row must not fail the job.
    logger.warn('failed to record video usage event', { jobId: job.id, error });
  }
};

const notify = async (job: IGenerationJobDocument): Promise<void> => {
  const sender = new ClientMessageSender({ connections: Connection }, logger);
  await sender.sendToClient(job.requestedBy, Resource.websocket.managementEndpoint, toJobUpdate(job));
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
  engine: getGenerationJobEngine(),
});

let generationJobEngine: GenerationJobEngine | undefined;
export const getGenerationJobEngine = (): GenerationJobEngine => {
  generationJobEngine ??= new GenerationJobEngine({
    repository: generationJobRepository,
    handlers: [createVideoJobHandler(getVideoJobDeps())],
    enqueue: enqueueGenerationJob,
    notify,
    now: () => new Date(),
    logger,
    leaseMs: LEASE_MS,
  });
  return generationJobEngine;
};
