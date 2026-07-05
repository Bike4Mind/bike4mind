import {
  IAdminSettingsRepository,
  IUserDocument,
  IUserRepository,
  IFabFileRepository,
  KnowledgeType,
  ITaskScheduleRepository,
  ResearchTaskExecutionType,
  TaskScheduleHandler,
  ResearchTaskPeriodicFrequencyType,
  IFabFileDocument,
  IFileTagRepository,
  IFileTag,
  IResearchTask,
  IResearchTaskDeepResearch,
  IApiKeyRepository,
} from '@bike4mind/common';
import { NotFoundError, BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  ResearchTaskStatus,
  ResearchTaskType,
  IResearchTaskRepository,
  IResearchTaskScrape,
  IResearchDataRepository,
} from '@bike4mind/common';
import { fabFilesService, tagService, taskSchedulerService } from '..';
import { htmlToMarkdown } from '../lib/turndown';
import { getLinksFromHtml } from '../lib/cheerio';
import pLimit from 'p-limit';
import { FunctionQueueRunner } from '@bike4mind/utils';
import { findOrUpdateExistingResearchData, createSendStatusUpdate } from './utils';
import { performDeepResearch } from '../llm/tools/implementation/deepResearch';
import { CreateFabFileAdapters } from '../fabFileService';
import { ToolContext } from '../llm/tools/base/types';
import { getEffectiveLLMApiKeys } from '../apiKeyService';

type ResearchTaskProcessParameters = { id: string };

interface ResearchTaskProcessAdapters {
  db: {
    transaction: <T>(fn: () => Promise<T>) => Promise<T>;
    researchTasks: IResearchTaskRepository;
    fabFiles: Pick<IFabFileRepository, 'create' | 'findById' | 'update' | 'shareable'>;
    fileTags: Pick<
      IFileTagRepository,
      'findByIdAndUserId' | 'create' | 'findByNameAndUserId' | 'incrementFileCountByIds'
    >;
    users: Pick<IUserRepository, 'findById'>;
    adminSettings: IAdminSettingsRepository;
    researchDatas: IResearchDataRepository;
    taskSchedules: ITaskScheduleRepository;
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndType' | 'findByUserIdAndTypes'>;
  };
  llm: Pick<ICompletionBackend, 'complete' | 'currentModel'>;
  storage: CreateFabFileAdapters['storage'];
  imageGeneratStorage?: CreateFabFileAdapters['storage'];
  scraper: {
    fetch: (url: string) => Promise<{
      rawHtml: string;
      metadata?: Record<string, unknown>;
    }>;
  };
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  jobs: {
    file?: {
      chunk: (fabFileId: string) => Promise<unknown>;
    };
    researchTasks: {
      processDiscoveredLinks: (id: string, userId: string) => Promise<void>;
      sendToClient: (
        researchTask: IResearchTask,
        update: { status: string; currentStep: string; progress: number }
      ) => Promise<void>;
    };
  };
}

export const process = async (
  user: IUserDocument,
  parameters: ResearchTaskProcessParameters,
  adapters: ResearchTaskProcessAdapters
) => {
  const { db, logger } = adapters;

  let researchTask = await db.researchTasks.findByIdAndUserId(parameters.id, user.id);

  if (!researchTask) {
    throw new NotFoundError('Research task not found');
  }

  if (
    researchTask.status === ResearchTaskStatus.COMPLETED &&
    researchTask.executionType !== ResearchTaskExecutionType.PERIODIC
  ) {
    throw new BadRequestError('Research task is completed');
  }

  // Update status to PROCESSING before starting (no transaction needed for single operation)
  researchTask.status = ResearchTaskStatus.PROCESSING;
  await db.researchTasks.update(researchTask);

  logger?.info(`✅ [PROCESS_START] Processing research task ${researchTask.id} with status: ${researchTask.status}`);

  const files: IFabFileDocument[] = [];

  // No transaction wrapper: processScrape/processDeepResearch make FireCrawl calls, S3 uploads,
  // WebSocket updates, and HTML processing that can exceed MongoDB's 60s transaction timeout.
  try {
    switch (researchTask.type) {
      case ResearchTaskType.SCRAPE:
        await processScrape(user, { researchTask, files }, adapters);
        break;
      case ResearchTaskType.DEEP_RESEARCH:
        await processDeepResearch(user, { researchTask, files }, adapters);
        break;
      default:
        throw new Error(`Unsupported research task type: ${researchTask.type}`);
    }

    // Success: Task will be marked as COMPLETED in the phase completion logic below
    // (either immediately if no link discovery, or after processDiscoveredLinks completes)
  } catch (e) {
    logger?.error(`❌ [PROCESS_ERROR] Failed to process research task: ${(e as Error).message}`);

    researchTask.status = ResearchTaskStatus.FAILED;
    researchTask.statusFailedMessage = (e as Error).message;
    researchTask.statusFailedAt = new Date();

    await db.researchTasks.update(researchTask);

    try {
      await adapters.jobs.researchTasks.sendToClient(researchTask, {
        currentStep: `❌ Task failed: ${(e as Error).message}`,
        progress: 0,
        status: 'failed',
      });
    } catch (notifyError) {
      logger?.error(`Failed to send failure notification to client: ${(notifyError as Error).message}`);
    }

    // Re-throw to let queue handler know processing failed
    throw e;
  }

  // Reload task to get any updates made during processing
  researchTask = (await db.researchTasks.findById(parameters.id))!;

  // If the task is periodic and completed and the end date is not passed, schedule it
  if (
    researchTask.executionType === ResearchTaskExecutionType.PERIODIC &&
    researchTask.status === ResearchTaskStatus.COMPLETED &&
    researchTask.executionPeriodicEndAt > new Date()
  ) {
    const nextProcessDate = getNextProcessDate(researchTask.executionPeriodicFrequency);

    if (nextProcessDate < researchTask.executionPeriodicEndAt) {
      await taskSchedulerService.create(
        {
          handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
          payload: {
            id: researchTask.id,
            userId: user.id,
          },
          processDate: nextProcessDate,
        },
        adapters
      );
    }
  }

  if (researchTask.type === ResearchTaskType.SCRAPE && researchTask.status !== ResearchTaskStatus.FAILED) {
    const { jobs } = adapters;

    if (researchTask.canDiscoverLinks && researchTask.discoveredLinks && researchTask.discoveredLinks.length > 0) {
      logger?.info(
        `💼 [SENDING_BACKGROUND_JOB] Sending background job to process discovered links for research task ${researchTask.id} links: ${researchTask.discoveredLinks.length}`
      );

      await jobs.researchTasks.processDiscoveredLinks(researchTask.id, researchTask.userId);

      try {
        await jobs.researchTasks.sendToClient(researchTask, {
          currentStep: `🔍 Preparing ${researchTask.discoveredLinks.length} discovered links for processing...`,
          progress: 40,
          status: 'processing',
        });
      } catch (e) {
        logger?.error('Failed to send status update to client');
      }
    } else {
      researchTask.status = ResearchTaskStatus.COMPLETED;
      researchTask.statusCompletedAt = new Date();
      await db.researchTasks.update(researchTask);

      try {
        await jobs.researchTasks.sendToClient(researchTask, {
          currentStep: '🎉 Research task completed',
          progress: 100,
          status: 'completed',
        });
      } catch (e) {
        logger?.error('Failed to send status update to client');
      }
    }
  }
};

export const getNextProcessDate = (frequency: ResearchTaskPeriodicFrequencyType) => {
  const now = new Date();
  const nextDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  switch (frequency) {
    case ResearchTaskPeriodicFrequencyType.DAILY:
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      break;
    case ResearchTaskPeriodicFrequencyType.WEEKLY:
      nextDate.setUTCDate(nextDate.getUTCDate() + 7);
      break;
    case ResearchTaskPeriodicFrequencyType.MONTHLY:
      nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
      break;
  }
  return nextDate;
};

/**
 * Process a scrape research task
 *
 * This function will set the values of researchTask and files.
 *
 * @param user The user who owns the research task
 * @param params The parameters for the research task
 * @param adapters The adapters for the research task
 */
const processScrape = async (
  user: IUserDocument,
  params: {
    researchTask: IResearchTaskScrape;
    files: IFabFileDocument[];
  },
  adapters: ResearchTaskProcessAdapters
) => {
  const { researchTask, files } = params;
  const { db, scraper, logger, jobs } = adapters;
  const { sendToClient } = jobs.researchTasks || {};
  const { canDiscoverLinks, urls } = researchTask;

  logger?.info(`🎬 [PROCESS_SCRAPE_START] Starting processScrape for task ${researchTask.id}`);
  logger?.info(`🎬 [PROCESS_SCRAPE_CONFIG] canDiscoverLinks: ${canDiscoverLinks}`);

  researchTask.discoveredLinks ||= [];

  // Tag preparation
  const tagsToApply: IFileTag[] = [];
  if (researchTask.fileTagId) {
    const tag = await db.fileTags.findByIdAndUserId(researchTask.fileTagId, user.id);

    if (tag) {
      tagsToApply.push(tag);
    } else {
      logger?.info(`🏷️ [TAG_NOT_FOUND] Tag ${researchTask.fileTagId} not found for user ${user.id}`);
    }
  } else if (researchTask.autoGeneratedTag) {
    let tag = await db.fileTags.findByNameAndUserId(researchTask.autoGeneratedTag.name, user.id);
    if (tag) {
      tagsToApply.push(tag);
    } else {
      logger?.info(`🏷️ [TAG_NOT_FOUND] Tag ${researchTask.autoGeneratedTag.name} not found for user ${user.id}`);
      tag = await tagService.createFileTag(user.id, researchTask.autoGeneratedTag, adapters);
      tagsToApply.push(tag);
      logger?.info(`✅ [TAG_CREATED] Created and added new tag: ${tag.name} (${tag.id})`);
    }
  }

  const maxProgress = researchTask.canDiscoverLinks ? 40 : 100; // Process phase: 0-40%

  const queueRunner = new FunctionQueueRunner(2000);
  const currentProgressTracker = { value: 0 };
  const sendStatusUpdate = createSendStatusUpdate(researchTask, queueRunner, sendToClient, logger, {
    maxProgress,
    baseProgress: 0,
    currentProgress: currentProgressTracker,
  });

  await sendStatusUpdate('🌐 Starting research task...', 0);

  const scrapeUrl = async (url: string, index: number) => {
    logger?.info(`🎬 [PROCESS_SCRAPE_URL] Target URL: ${url} (${index + 1}/${urls.length})`);

    logger?.info(`🚀 [RESEARCH_START] Beginning research task ${researchTask.id} for URL: ${url}`);
    logger?.info(`🌐 [FIRECRAWL_START] Fetching content from ${url}`);

    await sendStatusUpdate(`🌐 [${index}/${urls.length}] Connecting to target website...`, 0);

    let rawHtml: string;
    let metadata: Record<string, unknown>;
    try {
      logger?.info(`🔧 [SCRAPER_CALL] About to call scraper.fetch(${url})`);
      const scrapeResult = await scraper.fetch(url);
      rawHtml = scrapeResult.rawHtml;
      metadata = {
        ...(scrapeResult.metadata || {}),
        url,
      };
      logger?.info(`✅ [FIRECRAWL_SUCCESS] Fetched ${rawHtml.length} characters of HTML content`);
    } catch (scrapeError) {
      logger?.error(`❌ [FIRECRAWL_ERROR] Failed to fetch content from ${url}: ${JSON.stringify(scrapeError)}`);
      logger?.error(
        `❌ [FIRECRAWL_ERROR_DETAILS] Error type: ${typeof scrapeError}, Message: ${(scrapeError as Error).message}`
      );
      throw scrapeError;
    }

    await sendStatusUpdate(
      `📄 [${index}/${urls.length}] Extracting and cleaning content...`,
      Math.floor((30 * maxProgress) / (100 * urls.length))
    );
    const content = htmlToMarkdown(rawHtml);
    logger?.info(`📝 [CONTENT_PROCESSED] Converted to ${content.length} characters of markdown`);

    const arrTags = tagsToApply.map(t => ({ name: t.name, strength: 1.0 }));

    await sendStatusUpdate(
      `💾 [${index}/${urls.length}] Creating main research file...`,
      Math.floor((30 * maxProgress) / (100 * urls.length))
    );
    logger?.info(`📁 [FILE_CREATE_START] Creating main file with tag: ${tagsToApply.map(t => t.name).join(', ')}`);

    let mainFile: IFabFileDocument;

    try {
      const mainFileData = {
        fileName: `${researchTask.title} (${index + 1}/${urls.length}).md`,
        mimeType: 'text/markdown',
        content,
        type: KnowledgeType.TEXT,
        fileSize: Buffer.byteLength(content, 'utf8'),
        organizationId: researchTask.organizationId,
        tags: arrTags,
      };

      // Check if the research data already exists and handle file creation/update
      const result = await findOrUpdateExistingResearchData(
        url,
        content,
        'text/markdown',
        researchTask,
        user,
        adapters,
        logger
      );

      if (result?.file) {
        mainFile = result.file;
      } else {
        const createFileAdapters = {
          db: adapters.db,
          storage: adapters.storage,
        };
        mainFile = await fabFilesService.createFabFile(user.id, mainFileData, createFileAdapters);
      }

      files.push(mainFile);
      logger?.info(`✅ [FILE_CREATED] Main file created: ${mainFile.id} (${mainFile.fileName})`);
    } catch (fileError) {
      logger?.error(`❌ [FILE_CREATE_ERROR] Failed to create main file: ${JSON.stringify(fileError)}`);
      logger?.error(
        `❌ [FILE_CREATE_ERROR_DETAILS] Error type: ${typeof fileError}, Message: ${(fileError as Error).message}`
      );
      throw fileError;
    }

    const isExistingData = await db.researchDatas.existsByUrlAndResearchTaskId(url, researchTask.id);

    // Create research data only if this URL isn't already tracked for the task
    if (!isExistingData) {
      await db.researchDatas.create({
        fabFileId: mainFile.id,
        researchAgentId: researchTask.researchAgentId,
        researchTaskId: researchTask.id,
        organizationId: researchTask.organizationId,
        metaData: metadata,
        url,
        userId: researchTask.userId,
      });

      logger?.info(`🗃️ [RESEARCH_DATA_CREATED] Linked main file to research task`);
    }

    if (canDiscoverLinks) {
      await sendStatusUpdate(
        `🔍 [${index}/${urls.length}] Analyzing page for downloadable links...`,
        Math.floor((20 * maxProgress) / (100 * urls.length))
      );
      logger?.info(`🔗 [LINK_DISCOVERY_START] Extracting links from HTML content`);

      const links = getLinksFromHtml(rawHtml);
      logger?.info(`🔗 [LINKS_EXTRACTED] Found ${links.length} total links to analyze`);

      researchTask.discoveredLinks ||= [];
      researchTask.discoveredLinks.forEach(l => (l.status = 'pending'));
      const stats = {
        added: 0,
        updated: 0,
      };
      links.forEach(l => {
        const existingLink = researchTask.discoveredLinks?.find(ll => ll.url === l);

        if (existingLink) {
          existingLink.status = 'pending';
          existingLink.sourceUrl = url;
          stats.updated++;
        } else {
          researchTask.discoveredLinks?.push({
            url: l,
            status: 'pending',
            sourceUrl: url,
          });
          stats.added++;
        }
      });

      logger?.info(`🔍 [LINKS_STATS] Stats - Added: ${stats.added}, Updated: ${stats.updated}`);
    } else {
      researchTask.discoveredLinks = [];
      logger?.info(`🔗 [LINKS_DISABLED] Link discovery disabled, setting empty discoveredLinks array`);
    }

    await sendStatusUpdate(
      `⚡ [${index}/${urls.length}] Optimizing files for intelligent search...`,
      Math.floor((30 * maxProgress) / (100 * urls.length))
    );
    logger?.info(`🔄 [CHUNKING_START] Queueing ${files.length} files for chunking and vectorization`);

    logger?.info(`🎉 [RESEARCH_COMPLETE] Task ${researchTask.id} completed successfully with ${files.length} files`);
  };

  const sequential = pLimit(1);

  await Promise.all(urls.map((url, index) => sequential(async () => scrapeUrl(url, index + 1))));

  await queueRunner.close();
};

/**
 * Process a deep research task
 *
 * This function will perform comprehensive research using the deep research tool
 *
 * @param user The user who owns the research task
 * @param params The parameters for the research task
 * @param adapters The adapters for the research task
 */
const processDeepResearch = async (
  user: IUserDocument,
  params: {
    researchTask: IResearchTaskDeepResearch;
    files: IFabFileDocument[];
  },
  adapters: ResearchTaskProcessAdapters
) => {
  const { researchTask, files } = params;
  const { db, llm, logger, jobs } = adapters;
  const { sendToClient } = jobs.researchTasks || {};

  logger?.info(`🔬 [PROCESS_DEEP_RESEARCH_START] Starting processDeepResearch for task ${researchTask.id}`);
  logger?.info(
    `🔬 [DEEP_RESEARCH_CONFIG] Description: ${researchTask.description}, MaxDepth: ${researchTask.maxDepth || 7}`
  );

  // Tag preparation
  const tagsToApply: IFileTag[] = [];
  if (researchTask.fileTagId) {
    const tag = await db.fileTags.findByIdAndUserId(researchTask.fileTagId, user.id);
    if (tag) {
      tagsToApply.push(tag);
    }
  } else if (researchTask.autoGeneratedTag) {
    let tag = await db.fileTags.findByNameAndUserId(researchTask.autoGeneratedTag.name, user.id);
    if (tag) {
      tagsToApply.push(tag);
    } else {
      tag = await tagService.createFileTag(user.id, researchTask.autoGeneratedTag, adapters);
      tagsToApply.push(tag);
      logger?.info(`✅ [TAG_CREATED] Created and added new tag: ${tag.name} (${tag.id})`);
    }
  }

  const queueRunner = new FunctionQueueRunner(2000);

  try {
    await sendToClient?.(researchTask, {
      status: 'processing',
      currentStep: '🔬 Starting deep research...',
      progress: 0,
    });

    const apiKeys = await getEffectiveLLMApiKeys(user.id, { db: adapters.db, getSettingsByNames });

    const toolContext: ToolContext = {
      userId: user.id,
      user: user,
      db: adapters.db,
      storage: {
        upload: adapters.storage.upload,
        getSignedUrl: (path: string) => adapters.storage.generateSignedUrl(path, 3600),
        getPublicUrl: () => '',
      },
      imageGenerateStorage: {
        upload: adapters.storage.upload,
        getSignedUrl: (path: string) => adapters.storage.generateSignedUrl(path, 3600),
        getPublicUrl: () => '',
      },
      llm: llm,
      logger: logger as Logger,
      statusUpdate: async (update: any) => {
        if (update.deepResearchState) {
          const progress = Math.round(
            (update.deepResearchState.completedSteps / update.deepResearchState.totalExpectedSteps) * 100
          );
          sendToClient?.(researchTask, {
            status: 'processing',
            currentStep:
              update.deepResearchState.activities[update.deepResearchState.activities.length - 1]?.message ||
              'Processing...',
            progress: Math.min(progress, 95), // Cap at 95% until file creation
          }).catch(() => {});
        }
      },
      onFinish: async (_toolName: string, state: any) => {
        logger?.info(`🔬 [DEEP_RESEARCH_FINISHED] Research completed with ${state.findings.length} findings`);
      },
    };

    const result = await performDeepResearch(
      toolContext,
      {
        topic: researchTask.description,
      },
      {
        maxDepth: researchTask.maxDepth || 7,
        duration: researchTask.duration || 4.5,
        model: llm.currentModel,
        apiKeys,
      }
    );

    if (!result.success) {
      throw new Error(result.error || 'Deep research failed');
    }

    await sendToClient?.(researchTask, {
      status: 'processing',
      currentStep: '📄 Creating research report...',
      progress: 95,
    });

    const arrTags = tagsToApply.map(t => ({ name: t.name, strength: 1.0 }));

    const collatedFindings = result.data.findings
      .map((finding, index) => `## Finding ${index + 1}\n\n**Source:** ${finding.source}\n\n${finding.text}\n\n---\n`)
      .join('\n');

    const reportContent = `# ${researchTask.title} - Research Report\n\n**Research Description:** ${researchTask.description}\n\n**Total Findings:** ${result.data.findings.length}\n\n---\n\n${collatedFindings}`;
    const mainFileData = {
      fileName: `${researchTask.title} - Deep Research Report - ${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
      mimeType: 'text/markdown',
      content: reportContent,
      type: KnowledgeType.TEXT,
      fileSize: Buffer.byteLength(reportContent, 'utf8'),
      organizationId: researchTask.organizationId,
      tags: arrTags,
    };

    const createFileAdapters = {
      db: adapters.db,
      storage: adapters.storage,
    };
    const mainFile = await fabFilesService.createFabFile(user.id, mainFileData, createFileAdapters);
    files.push(mainFile);
    logger?.info(
      `✅ [FILE_CREATED] Deep research report created: ${mainFile.id} (${mainFile.fileName}): ${mainFile.tags}`
    );

    await db.researchDatas.create({
      fabFileId: mainFile.id,
      researchAgentId: researchTask.researchAgentId,
      researchTaskId: researchTask.id,
      organizationId: researchTask.organizationId,
      metaData: { description: researchTask.description, maxDepth: researchTask.maxDepth },
      url: `deep-research://${researchTask.description}`,
      userId: researchTask.userId,
    });

    logger?.info(`🗃️ [RESEARCH_DATA_CREATED] Linked deep research report to research task`);

    researchTask.status = ResearchTaskStatus.COMPLETED;
    researchTask.statusCompletedAt = new Date();
    await db.researchTasks.update(researchTask);

    await sendToClient?.(researchTask, {
      status: 'completed',
      currentStep: '🎉 Deep research completed',
      progress: 100,
    });
  } catch (error) {
    logger?.error(`❌ [DEEP_RESEARCH_ERROR] Failed to process deep research: ${error}`);
    throw error;
  } finally {
    await queueRunner.close();
  }
};
