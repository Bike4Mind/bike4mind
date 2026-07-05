import {
  IFabFileDocument,
  IFabFileRepository,
  IFileTagRepository,
  IAdminSettingsRepository,
  IResearchDataRepository,
  IResearchTaskRepository,
  IResearchTaskScrape,
  IUserRepository,
  IResearchTask,
  KnowledgeType,
  ResearchTaskStatus,
  ResearchTaskType,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnprocessableEntityError, FunctionQueueRunner } from '@bike4mind/utils';
import { createSendStatusUpdate } from './utils';
import { z } from 'zod';
import plimit from 'p-limit';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { findOrUpdateExistingResearchData, prepareTagsForResearchTask } from './utils';
import { fabFilesService } from '..';
import { CreateFabFileAdapters } from '../fabFileService';

const researchTaskDownloadRelevantLinksSchema = z.object({
  id: z.string(),
});

type IResearchTaskDownloadRelevantLinks = z.infer<typeof researchTaskDownloadRelevantLinksSchema>;

interface IResearchTaskDownloadRelevantLinksAdapters {
  db: {
    researchTasks: IResearchTaskRepository;
    researchDatas: IResearchDataRepository;
    users: IUserRepository;
    fabFiles: IFabFileRepository;
    fileTags: IFileTagRepository;
    adminSettings: IAdminSettingsRepository;
  };
  storage: CreateFabFileAdapters['storage'];
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  jobs: {
    file?: {
      chunk: (fabFileId: string) => Promise<unknown>;
    };
    researchTasks?: {
      sendToClient: (
        researchTask: IResearchTask,
        update: { status: string; currentStep: string; progress: number }
      ) => Promise<void>;
    };
  };
}

// TODO: have this as an admin settings
const BATCH_SIZE = 3;

export const downloadRelevantLinks = async (
  parameters: IResearchTaskDownloadRelevantLinks,
  adapters: IResearchTaskDownloadRelevantLinksAdapters
) => {
  const { db, logger } = adapters;
  const { id } = secureParameters(parameters, researchTaskDownloadRelevantLinksSchema);

  const researchTask = await db.researchTasks.findById(id);

  if (!researchTask) throw new NotFoundError(`Research Task Download Relevant Links - Research Task ${id} not found`);

  if (researchTask.type !== ResearchTaskType.SCRAPE)
    throw new UnprocessableEntityError(
      `Research Task Download Relevant Links - Research Task ${id} is not a scrape task`
    );

  const user = await db.users.findById(researchTask.userId);
  if (!user) throw new NotFoundError(`Research Task Download Relevant Links - User ${researchTask.userId} not found`);

  const relevantLinks = researchTask.discoveredLinks?.filter(l => l.isDownloadable && l.relevance && l.relevance > 0.7);
  if (!relevantLinks?.length) return;

  const queueRunner = new FunctionQueueRunner(2000);
  const { sendToClient } = adapters.jobs.researchTasks || {};

  const currentProgressTracker = { value: 0 };
  const sendStatusUpdate = createSendStatusUpdate(researchTask, queueRunner, sendToClient, logger, {
    baseProgress: 71,
    maxProgress: 100, // Download relevant links phase: 71-100%
    currentProgress: currentProgressTracker,
  });

  const limit = plimit(BATCH_SIZE);
  function getIndex(url: string) {
    return (researchTask as IResearchTaskScrape).urls.findIndex(url => url === url);
  }

  const tagsToApply = await prepareTagsForResearchTask({ user, researchTask }, adapters);

  const arrTags = tagsToApply.map(t => ({ name: t.name, strength: 1.0 }));

  await sendStatusUpdate(`⬇️ Starting download of ${relevantLinks.length} high-value files...`, 3);

  let downloadCount = 0;
  const files: IFabFileDocument[] = [];
  const progressPerDownload = Math.floor(18 / relevantLinks.length); // Reserve 18% for downloads (within 29% range)

  await Promise.all(
    relevantLinks?.map(link =>
      limit(async () => {
        try {
          logger?.info(`📥 [DOWNLOAD] Starting download: ${link.url}`);
          const response = await axios.get(link.url, {
            responseType: 'arraybuffer',
          });
          const buffer = Buffer.from(response.data);
          const fileType = await fileTypeFromBuffer(buffer);
          const index = getIndex(link.url) + 1;

          if (!fileType) {
            logger?.error(`❌ [DOWNLOAD_${index}] Could not determine file type for ${link.url}`);
            return;
          }

          // Prevent downloading unsupported fabfile mimetypes
          if (!Object.values<string>(SupportedFabFileMimeTypes).includes(fileType.mime)) {
            logger?.info(`❌ [DOWNLOAD_${index}] Unsupported file type: ${fileType.mime} for ${link.url}`);
            return;
          }

          const downloadedFileData = {
            content: buffer,
            fileName: `[${researchTask.title}] ${link.text}.${fileType.ext}`,
            mimeType: fileType.mime,
            type: KnowledgeType.URL,
            fileSize: buffer.length,
            organizationId: researchTask.organizationId,
            prefix: `research-tasks/${researchTask.id}`,
            tags: arrTags,
          };

          const existingDownloadResult = await findOrUpdateExistingResearchData(
            link.url,
            buffer,
            fileType.mime,
            researchTask,
            user,
            adapters,
            logger
          );

          let downloadedFile: IFabFileDocument;

          if (existingDownloadResult?.file) {
            downloadedFile = existingDownloadResult.file;
            logger?.info(
              `✅ [DOWNLOAD_${index + 1}] File updated: ${downloadedFile.id} ${
                downloadedFile.mimeType
              } (${buffer.length} bytes)`
            );
          } else {
            downloadedFile = await fabFilesService.createFabFile(user.id, downloadedFileData, adapters);
            logger?.info(
              `✅ [DOWNLOAD_${index + 1}] File created: ${downloadedFile.id} ${
                downloadedFile.mimeType
              } (${buffer.length} bytes)`
            );
          }

          files.push(downloadedFile);

          const isExistingData = await db.researchDatas.existsByUrlAndResearchTaskId(link.url, researchTask.id);

          // Create research data only if this URL isn't already tracked for the task
          if (!isExistingData) {
            await db.researchDatas.create({
              fabFileId: downloadedFile.id,
              researchAgentId: researchTask.researchAgentId,
              researchTaskId: researchTask.id,
              organizationId: researchTask.organizationId,
              url: link.url,
              userId: researchTask.userId,
            });
          }

          downloadCount++;
          logger?.info(`📊 [DOWNLOAD_PROGRESS] Completed ${downloadCount}/${relevantLinks.length} downloads`);

          await sendStatusUpdate(
            `📥 Downloaded ${downloadCount}/${relevantLinks.length}: ${link.text}`,
            progressPerDownload
          );
        } catch (error) {
          logger?.error(`❌ [DOWNLOAD_ERROR] Failed to download file from ${link.url}: ${(error as Error).message}`);
          await sendStatusUpdate(`❌ Download failed: ${link.text} - ${(error as Error).message}`, progressPerDownload);
        }
      })
    )
  );

  // Auto-trigger chunking for files
  if (files.length > 0) {
    await sendStatusUpdate(`⚡ Optimizing ${files.length} files for intelligent search...`, 4);

    const chunkPromises = files.map(async (file, index) => {
      return limit(async () => {
        try {
          if (adapters.jobs.file?.chunk) {
            await adapters.jobs.file.chunk(file.id);
            logger?.info(`✅ [CHUNK_QUEUED_${index + 1}] File ${file.id} queued for chunking`);
          } else {
            logger?.info(`⚠️ [CHUNK_SKIP_${index + 1}] No chunking service available for file ${file.id}`);
          }
        } catch (error) {
          logger?.error(
            `❌ [CHUNK_ERROR_${index + 1}] Failed to queue chunking for file ${file.id}: ${(error as Error).message}`
          );
        }
      });
    });

    await Promise.all(chunkPromises);
    logger?.info(`🔄 [CHUNKING_QUEUED] All ${files.length} files queued for background processing!`);
  }

  await sendStatusUpdate(`🎉 Research task completed with ${downloadCount} files downloaded`, 100);

  await queueRunner.close();

  researchTask.status = ResearchTaskStatus.COMPLETED;
  await db.researchTasks.update(researchTask);
};
