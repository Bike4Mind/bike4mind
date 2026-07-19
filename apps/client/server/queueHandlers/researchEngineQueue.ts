import { z } from 'zod';
import { researchTaskService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  researchTaskRepository,
  researchDataRepository,
  withTransaction,
  apiKeyRepository,
  userRepository,
} from '@bike4mind/database';
import { IAdminSettingsRepository, IUserRepository } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { fabFileRepository } from '@bike4mind/database';
import { getFilesStorage } from '@server/utils/storage';
// Interop-safe constructor (not the raw default import) - see firecrawlApp.ts in services
import { FirecrawlApp } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { scrapeWithRetry } from '@bike4mind/services/llm/tools/implementation/webfetch/scrapeWithRetry';
import { taskScheduleRepository } from '@bike4mind/database';
import { ResearchTaskStatus } from '@bike4mind/common';
import { fileTagRepository } from '@bike4mind/database';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { Logger } from '@bike4mind/observability';
import { researchTaskJobs } from '@server/jobs/researchTasks';
import { OperationsModelService } from '@client/services/operationsModelService';

const researchEngineQueuePayload = z.object({
  action: z.enum(['process', 'processDiscoveredLinks', 'downloadRelevantLinks']),
  payload: z.object({
    id: z.string(),
    userId: z.string(),
  }),
});

/**
 * This is the main queue handler for the research engine.
 * It dispatches the appropriate action based on the event.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { action, payload } = researchEngineQueuePayload.parse(JSON.parse(body));

  logger.info('Dispatching action', { action, payload });

  switch (action) {
    case 'process':
      await process(payload, logger);
      break;
    case 'processDiscoveredLinks':
      await processDiscoveredLinks(payload, logger);
      break;
    case 'downloadRelevantLinks':
      await downloadRelevantLinks(payload, logger);
      break;
  }
});

const process = async (parameters: { id: string; userId: string }, logger: Logger) => {
  const { id: researchTaskId, userId } = parameters;

  logger.updateMetadata({ handler: 'researchEngineQueue', userId, researchTaskId });
  logger.log('====================================');
  logger.log(`Started research task queue handler for researchTaskId: ${researchTaskId}`);
  logger.log('====================================');

  try {
    try {
      const { modelId, llm } = await OperationsModelService.getOperationsTextModel();
      llm.currentModel = modelId;

      if (!llm) {
        throw new Error('No LLM found');
      }

      const user = await User.findById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      await researchTaskService.process(
        user as any,
        { id: researchTaskId },
        {
          db: {
            fileTags: fileTagRepository,
            transaction: withTransaction,
            researchTasks: researchTaskRepository,
            users: userRepository,
            researchDatas: researchDataRepository,
            fabFiles: fabFileRepository,
            adminSettings: adminSettingsRepository,
            taskSchedules: taskScheduleRepository,
            apiKeys: apiKeyRepository,
          },
          llm,
          scraper: {
            fetch: async (url: string) => {
              const apiKey = await adminSettingsRepository.findBySettingName('FirecrawlApiKey');

              if (!apiKey) {
                throw new Error('Scraping API key not set');
              }

              logger.info(`Scraping URL: ${url}`);
              const app = new FirecrawlApp({ apiKey: apiKey?.settingValue });
              return scrapeWithRetry(app, url, logger);
            },
          },
          storage: {
            generateSignedUrl: (filepath: string, expireInSeconds: number, type = 'get') =>
              getFilesStorage().getSignedUrl(filepath, type, {
                expiresIn: expireInSeconds,
              }),
            upload: async (destination, input, options) => {
              logger.log(`Uploading content to ${destination}`);
              logger.log(`Content length: ${Buffer.byteLength(input as string, 'utf8')} bytes`);
              await getFilesStorage().upload(input, destination, {
                ContentType: options?.ContentType || 'text/plain',
                ContentLength: options?.ContentLength || Buffer.byteLength(input as string, 'utf8'),
              });
              logger.log('Content uploaded successfully');
              return destination;
            },
          },
          logger,
          jobs: {
            researchTasks: researchTaskJobs,
          },
        }
      );
    } catch (processingError) {
      const err = processingError as Record<string, unknown>;
      logger.error(`Failed to process research task ${researchTaskId}`, {
        errorName: err?.name ?? 'Unknown',
        errorMessage: err?.message ?? 'No message',
        statusCode: err?.statusCode ?? 'No status code',
        stack: err?.stack ?? 'No stack',
        ...(err?.response
          ? {
              responseStatus: (err.response as Record<string, unknown>).status,
              responseData: (err.response as Record<string, unknown>).data,
            }
          : {}),
        ...(err?.error ? { firecrawlError: err.error } : {}),
      });

      // Reset task status to FAILED to prevent it from getting stuck in PROCESSING
      try {
        const researchTask = await researchTaskRepository.findById(researchTaskId);
        if (researchTask) {
          researchTask.status = ResearchTaskStatus.FAILED;
          researchTask.statusFailedMessage = (processingError as Error).message || 'Processing failed in queue handler';
          researchTask.statusFailedAt = new Date();
          await researchTaskRepository.update(researchTask);
          logger.log(`Task ${researchTaskId} status reset to FAILED`);
        }
      } catch (updateError) {
        logger.error('Failed to reset task status', { error: updateError });
      }

      throw processingError; // Re-throw for higher-level error handling
    }
  } catch (e) {
    logger.warn('Error processing research task', { error: e });
  }

  logger.log('====================================');
  logger.log('Completed research task queue handler');
  logger.log('====================================');
};

const processDiscoveredLinks = async (parameters: { id: string; userId: string }, logger: Logger) => {
  const { id: researchTaskId, userId } = parameters;

  logger.updateMetadata({ handler: 'researchEngineQueue', userId, researchTaskId });
  logger.log('====================================');
  logger.log(`Started processDiscoveredLinks queue handler for researchTaskId: ${researchTaskId}`);
  logger.log('====================================');

  const { modelId, llm } = await OperationsModelService.getOperationsTextModel();

  if (!llm) {
    throw new Error('No LLM found');
  }
  llm.currentModel = modelId;

  await researchTaskService.processDiscoveredLinks(
    {
      id: researchTaskId,
    },
    {
      db: {
        fabFiles: fabFileRepository,
        researchDatas: researchDataRepository,
        researchTasks: researchTaskRepository,
        withTransaction,
      },
      logger,
      jobs: {
        researchTasks: researchTaskJobs,
      },
      llm,
    }
  );

  logger.log('====================================');
  logger.log('Completed processDiscoveredLinks queue handler');
  logger.log('====================================');
};

const downloadRelevantLinks = async (parameters: { id: string; userId: string }, logger: Logger) => {
  const { id: researchTaskId, userId } = parameters;

  logger.updateMetadata({ handler: 'researchEngineQueue', researchTaskId, userId });
  logger.log('====================================');
  logger.log(`Started downloadRelevantLinks queue handler for researchTaskId: ${researchTaskId}`);
  logger.log('====================================');

  await researchTaskService.downloadRelevantLinks(
    {
      id: researchTaskId,
    },
    {
      db: {
        researchTasks: researchTaskRepository,
        fabFiles: fabFileRepository,
        researchDatas: researchDataRepository,
        adminSettings: adminSettingsRepository as unknown as IAdminSettingsRepository,
        users: {
          findById: async (id: string) => {
            const result = await User.findById(id);
            return result?.toJSON() ?? null;
          },
        } as unknown as IUserRepository,
        fileTags: fileTagRepository,
      },
      logger,
      storage: {
        generateSignedUrl: (filepath: string, expireInSeconds: number, type = 'get') =>
          getFilesStorage().getSignedUrl(filepath, type, {
            expiresIn: expireInSeconds,
          }),
        upload: async (filepath, content, option) => {
          logger.log(`Uploading content to ${filepath}`);
          logger.log(`Content length: ${Buffer.byteLength(content, 'utf8')} bytes`);
          await getFilesStorage().upload(content, filepath, {
            ContentType: option?.ContentType || 'text/plain',
            ContentLength: option?.ContentLength || Buffer.byteLength(content, 'utf8'),
          });
          logger.log('Content uploaded successfully');
          return filepath;
        },
      },
      jobs: {
        researchTasks: researchTaskJobs,
      },
    }
  );

  logger.log('====================================');
  logger.log('Completed downloadRelevantLinks queue handler!');
  logger.log('====================================');
};
