import {
  IFabFileDocument,
  IFabFileRepository,
  IFileTag,
  IFileTagRepository,
  IResearchData,
  IResearchDataRepository,
  IResearchTaskScrape,
  IResearchTask,
  IUserDocument,
  isImageServeable,
} from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';
import { FunctionQueueRunner } from '@bike4mind/utils';
import type { CreateFabFileAdapters } from '../fabFileService/create';
import { tagService } from '..';

/**
 * Utility function to find existing research data based on URL and organization/user context.
 * This implements the organization-first lookup pattern used throughout the research task processing.
 *
 * @param url - The URL to search for in research data
 * @param researchTask - The research task containing organization context
 * @param user - The user who owns the research task
 * @param researchDataRepository - The repository for research data operations
 * @returns Promise<IResearchData | null> - The existing research data if found, null otherwise
 */
export async function findExistingResearchData(
  url: string,
  researchTask: IResearchTaskScrape,
  user: IUserDocument,
  researchDataRepository: IResearchDataRepository
): Promise<IResearchData | null> {
  // Priority: Organization-level lookup first, then user-level fallback
  if (researchTask.organizationId) {
    return await researchDataRepository.findByUrlAndOrganizationId(url, researchTask.organizationId);
  } else {
    return await researchDataRepository.findByUrlAndUserId(url, user.id);
  }
}

/**
 * Enhanced version that also handles file update logic for existing research data.
 * This encapsulates the complete duplicate handling workflow.
 *
 * @param url - The URL to search for in research data
 * @param content - The content to upload (string or Buffer)
 * @param contentType - MIME type of the content
 * @param researchTask - The research task containing organization context
 * @param user - The user who owns the research task
 * @param adapters - Service adapters containing repositories and storage
 * @param logger - Optional logger for tracking operations
 * @returns the file and matching research data if a duplicate already existed (content re-uploaded), or null when no existing record was found
 */
export async function findOrUpdateExistingResearchData(
  url: string,
  content: string | Buffer,
  contentType: string,
  researchTask: IResearchTaskScrape,
  user: IUserDocument,
  adapters: {
    db: { researchDatas: IResearchDataRepository; fabFiles: Pick<IFabFileRepository, 'findById' | 'update'> };
    storage: CreateFabFileAdapters['storage'];
  },
  logger?: Pick<ILogger, 'info'>
): Promise<{ file: IFabFileDocument; researchData: IResearchData } | null> {
  const DEFAULT_EXPIRE_IN_SECONDS = 3600 * 24 * 5; // 5 days

  // Find existing research data using the standardized lookup
  const existingResearchData = await findExistingResearchData(url, researchTask, user, adapters.db.researchDatas);

  if (existingResearchData) {
    logger?.info(`🗃️ [RESEARCH_DATA_EXISTS] Research data already exists for ${url}`);

    const existingFile = await adapters.db.fabFiles.findById(existingResearchData.fabFileId);
    if (existingFile && existingFile.filePath) {
      logger?.info(`🗃️ [RESEARCH_DATA_EXISTS] Uploading content to existing file ${existingFile.filePath}`);

      // Upload new content to existing file
      await adapters.storage.upload(existingFile.filePath, content, {
        ContentType: contentType,
        ContentLength: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length,
      });

      // A re-crawl must not re-mint (or leave stale) a working GET url for a file that isn't
      // 'clean' - pending its scan, or quarantined (blocked). isImageServeable fail-closes on
      // ALL mime types (not just images), so a still-pending or legacy (pre-backfill) non-image
      // is withheld too; research content resolves to 'clean' on upload, so in steady state this
      // re-mints as before.
      if (isImageServeable(existingFile)) {
        existingFile.fileUrl = await adapters.storage.generateSignedUrl(
          existingFile.filePath,
          DEFAULT_EXPIRE_IN_SECONDS,
          'get'
        );
        existingFile.fileUrlExpireAt = new Date(Date.now() + DEFAULT_EXPIRE_IN_SECONDS * 1000);
      } else {
        existingFile.fileUrl = undefined;
        existingFile.fileUrlExpireAt = undefined;
      }
      existingFile.updatedAt = new Date();
      await adapters.db.fabFiles.update(existingFile);

      return { file: existingFile, researchData: existingResearchData };
    } else {
      throw new Error('Existing file not found');
    }
  }

  return null;
}

/**
 * Type guard to check if a research task has organization context
 *
 * @param researchTask - The research task to check
 * @returns boolean - True if the task has organization context
 */
export function hasOrganizationContext(researchTask: IResearchTaskScrape): boolean {
  return Boolean(researchTask.organizationId);
}

/**
 * Determines the appropriate scope (organization or user) for research data operations
 *
 * @param researchTask - The research task containing organization context
 * @param user - The user who owns the research task
 * @returns { scope: 'organization' | 'user', id: string } - The scope and corresponding ID
 */
export function getResearchDataScope(
  researchTask: IResearchTaskScrape,
  user: IUserDocument
): { scope: 'organization' | 'user'; id: string } {
  if (researchTask.organizationId) {
    return { scope: 'organization', id: researchTask.organizationId };
  } else {
    return { scope: 'user', id: user.id };
  }
}

/**
 * Prepares tags for research task processing by finding existing tags or creating new ones.
 * Handles both explicit fileTagId and auto-generated tags with detailed logging.
 *
 * @param researchTask - The research task containing tag information
 * @param user - The user who owns the research task
 * @param adapters - Service adapters containing repositories and tag service
 * @param logger - Optional logger for tracking operations
 * @returns Promise<IFileTag[]> - Array of tags ready to be applied to the file
 */
export async function prepareTagsForResearchTask(
  parameters: {
    user: IUserDocument;
    researchTask: IResearchTaskScrape;
  },
  adapters: {
    db: { fileTags: IFileTagRepository };
  },
  logger?: Pick<ILogger, 'info'>
): Promise<IFileTag[]> {
  const { user, researchTask } = parameters;
  const tagsToApply: IFileTag[] = [];

  if (researchTask.fileTagId) {
    const tag = await adapters.db.fileTags.findByIdAndUserId(researchTask.fileTagId, user.id);

    if (tag) {
      tagsToApply.push(tag);
    } else {
      logger?.info(`🏷️ [TAG_NOT_FOUND] Tag ${researchTask.fileTagId} not found for user ${user.id}`);
    }
  } else if (researchTask.autoGeneratedTag) {
    let tag = await adapters.db.fileTags.findByNameAndUserId(researchTask.autoGeneratedTag.name, user.id);
    if (tag) {
      tagsToApply.push(tag);
    } else {
      logger?.info(`🏷️ [TAG_NOT_FOUND] Tag ${researchTask.autoGeneratedTag.name} not found for user ${user.id}`);
      tag = await tagService.createFileTag(user.id, researchTask.autoGeneratedTag, adapters);
      tagsToApply.push(tag);
      logger?.info(`✅ [TAG_CREATED] Created and added new tag: ${tag.name} (${tag.id})`);
    }
  }

  return tagsToApply;
}

/**
 * Creates a standardized sendStatusUpdate function for research task processing.
 * This function handles progress tracking and WebSocket communication with proper error handling.
 *
 * @param researchTask - The research task being processed
 * @param queueRunner - Function queue runner for managing async operations
 * @param sendToClient - WebSocket client communication function
 * @param logger - Optional logger for tracking operations
 * @param progressConfig - Configuration for progress calculation
 * @returns Function that sends status updates with progress tracking
 */
export function createSendStatusUpdate(
  researchTask: IResearchTask,
  queueRunner: FunctionQueueRunner,
  sendToClient:
    | ((
        researchTask: IResearchTask,
        update: { status: string; currentStep: string; progress: number }
      ) => Promise<void>)
    | undefined,
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
  },
  progressConfig: {
    baseProgress: number;
    maxProgress: number;
    currentProgress: { value: number };
  } = {
    baseProgress: 0,
    maxProgress: 100,
    currentProgress: { value: 0 },
  }
): (status: string, progressIncrement?: number) => Promise<void> {
  return async (status: string, progressIncrement: number = 10) => {
    progressConfig.currentProgress.value += progressIncrement;
    const progress = Math.min(
      progressConfig.baseProgress + progressConfig.currentProgress.value,
      progressConfig.maxProgress
    );

    queueRunner.add(async () => {
      logger?.info(`📡 [RESEARCH_TASK_${researchTask.id}] Status: ${status} (${progress}%)`);

      try {
        if (sendToClient) {
          logger?.info(`📤 [WEBSOCKET_ATTEMPT] Sending status update: ${status}`);
          await sendToClient(researchTask, {
            status: 'processing',
            currentStep: status,
            progress,
          });
          logger?.info(`📡 [WEBSOCKET_SENT] TaskId: ${researchTask.id}, Status: ${status}, Progress: ${progress}%`);
        } else {
          logger?.info(`⚠️ [NO_STATUS_SENDER] StatusSender adapter not available for task ${researchTask.id}`);
        }
      } catch (error) {
        logger?.error(
          `❌ [WEBSOCKET_ERROR] Failed to send status update for task ${researchTask.id}: ${(error as Error).message}`
        );
      }
    });
  };
}
