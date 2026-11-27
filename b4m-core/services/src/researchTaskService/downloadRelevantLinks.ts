import {
  IFabFileDocument,
  IFabFileRepository,
  IFileTagRepository,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  IDataLakeRepository,
  IResearchDataRepository,
  IResearchTaskRepository,
  IResearchTaskScrape,
  IUserRepository,
  IOrganizationRepository,
  IResearchTask,
  KnowledgeType,
  ResearchTaskStatus,
  ResearchTaskType,
  limitConcurrency,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnprocessableEntityError, FunctionQueueRunner } from '@bike4mind/utils';
import { createSendStatusUpdate } from './utils';
import { z } from 'zod';
import { ssrfSafeDownload } from '@bike4mind/fab-pipeline';
import { fileTypeFromBuffer } from 'file-type';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { findOrUpdateExistingResearchData, prepareTagsForResearchTask } from './utils';
import * as fabFilesService from '../fabFileService';
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
    organizations: Pick<IOrganizationRepository, 'findById' | 'incrementCurrentStorage'>;
    fabFiles: IFabFileRepository;
    fileTags: IFileTagRepository;
    adminSettings: IAdminSettingsRepository;
    // Optional, but wire it: this `db` reaches `createFabFile`, whose admission contract (#1680)
    // resolves its enforcement lever from here. Absent, the lever resolves platform-only and a
    // per-org/owner/lake override silently does nothing on this door.
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
    // 'find' is forwarded straight to createFabFile, for its fallback tagger's prefix-overlap check.
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'find'>;
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
// Safety net only; createFabFile still enforces the MaxFileSize admin setting afterwards.
export const MAX_LINK_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const LINK_DOWNLOAD_TIMEOUT_MS = 60_000;
// Count of links downloaded per research task (highest relevance first).
export const MAX_LINKS_PER_RESEARCH_TASK = 25;
// Total bytes downloaded per research task (250 MiB), shared by all its links.
export const MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK = 250 * 1024 * 1024;

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

  const eligibleLinks = researchTask.discoveredLinks?.filter(l => l.isDownloadable && l.relevance && l.relevance > 0.7);
  if (!eligibleLinks?.length) return;

  const relevantLinks = [...eligibleLinks]
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
    .slice(0, MAX_LINKS_PER_RESEARCH_TASK);
  if (relevantLinks.length < eligibleLinks.length) {
    logger?.info(
      `[DOWNLOAD] Capped ${eligibleLinks.length} eligible links to the ${relevantLinks.length} most relevant`
    );
  }

  const queueRunner = new FunctionQueueRunner(2000);
  const { sendToClient } = adapters.jobs.researchTasks || {};

  const currentProgressTracker = { value: 0 };
  const sendStatusUpdate = createSendStatusUpdate(researchTask, queueRunner, sendToClient, logger, {
    baseProgress: 71,
    maxProgress: 100, // Download relevant links phase: 71-100%
    currentProgress: currentProgressTracker,
  });

  const limit = limitConcurrency(BATCH_SIZE);
  function getIndex(url: string) {
    return (researchTask as IResearchTaskScrape).urls.findIndex(url => url === url);
  }

  const tagsToApply = await prepareTagsForResearchTask({ user, researchTask }, adapters);

  const arrTags = tagsToApply.map(t => ({ name: t.name, strength: 1.0 }));

  await sendStatusUpdate(`⬇️ Starting download of ${relevantLinks.length} high-value files...`, 3);

  let downloadCount = 0;
  let keptPreviousCount = 0;
  let budgetSkippedCount = 0;
  // Bytes are reserved synchronously before each await, so concurrent downloads cannot overshoot the budget.
  let remainingBytes = MAX_DOWNLOAD_BYTES_PER_RESEARCH_TASK;
  // Reserved bytes of downloads still running; they come back unused if a download is smaller or fails.
  let inFlightBytes = 0;
  let settleWaiters: Array<() => void> = [];
  const settle = (reservedBytes: number, usedBytes: number) => {
    remainingBytes += reservedBytes - usedBytes;
    inFlightBytes -= reservedBytes;
    const waiters = settleWaiters;
    settleWaiters = [];
    waiters.forEach(wake => wake());
  };
  const files: IFabFileDocument[] = [];
  const progressPerDownload = Math.floor(18 / relevantLinks.length); // Reserve 18% for downloads (within 29% range)

  await Promise.all(
    relevantLinks?.map(link =>
      limit(async () => {
        let reserved = 0;
        try {
          // Skip or shrink the reservation only once no in-flight download can still refund bytes.
          while (remainingBytes < MAX_LINK_DOWNLOAD_BYTES && inFlightBytes > 0) {
            await new Promise<void>(wake => settleWaiters.push(wake));
          }
          if (remainingBytes <= 0) {
            budgetSkippedCount++;
            await sendStatusUpdate(`\u23ed\ufe0f Skipped (download budget reached): ${link.text}`, progressPerDownload);
            return;
          }
          reserved = Math.min(MAX_LINK_DOWNLOAD_BYTES, remainingBytes);
          remainingBytes -= reserved;
          inFlightBytes += reserved;
          logger?.info(`📥 [DOWNLOAD] Starting download: ${link.url}`);
          // Scraped page links are attacker-influenced: fetch through the full SSRF guard.
          const { data: buffer } = await ssrfSafeDownload(link.url, {
            maxBytes: reserved,
            timeoutMs: LINK_DOWNLOAD_TIMEOUT_MS,
          });
          settle(reserved, buffer.length);
          reserved = 0;
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

          if (existingDownloadResult?.storageLimitReached) {
            keptPreviousCount++;
            await db.researchTasks.addWarning(
              researchTask.id,
              `Storage limit reached: kept the previous copy of ${link.url}`
            );
            await sendStatusUpdate(`\u26a0\ufe0f Storage limit reached: kept the previous copy of ${link.text}`, 0);
          }

          if (existingDownloadResult?.file) {
            downloadedFile = existingDownloadResult.file;
            logger?.info(
              `✅ [DOWNLOAD_${index + 1}] File updated: ${downloadedFile.id} ${
                downloadedFile.mimeType
              } (${buffer.length} bytes)`
            );
          } else {
            // Narrowed rather than forwarding `adapters` wholesale: its `logger` is
            // `{info, error}`-shaped, not the `{warn?}` shape createFabFile's fallback-tagger
            // diagnostics expect, and `jobs` is unrelated to file creation.
            downloadedFile = await fabFilesService.createFabFile(user.id, downloadedFileData, {
              db: adapters.db,
              storage: adapters.storage,
            });
            if (existingDownloadResult) {
              await db.researchDatas.update({
                id: existingDownloadResult.researchData.id,
                fabFileId: downloadedFile.id,
              });
            }
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
          if (reserved > 0) settle(reserved, 0);
          logger?.error(`❌ [DOWNLOAD_ERROR] Failed to download file from ${link.url}: ${(error as Error).message}`);
          // Generic on purpose: the guard's message can name the private address a hostname resolved
          // to, which is logged above, not surfaced to the task owner.
          await sendStatusUpdate(`❌ Download failed: ${link.text}`, progressPerDownload);
        }
      })
    )
  );

  if (budgetSkippedCount > 0) {
    await db.researchTasks.addWarning(researchTask.id, `Download budget reached: skipped ${budgetSkippedCount} links`);
  }

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

  const keptNote = keptPreviousCount ? `, ${keptPreviousCount} kept their previous copy (storage limit reached)` : '';
  const budgetNote = budgetSkippedCount ? `, ${budgetSkippedCount} skipped (download budget reached)` : '';
  await sendStatusUpdate(
    `\u{1F389} Research task completed with ${downloadCount - keptPreviousCount} files downloaded${keptNote}${budgetNote}`,
    100
  );

  await queueRunner.close();

  researchTask.status = ResearchTaskStatus.COMPLETED;
  await db.researchTasks.update({ id: researchTask.id, status: researchTask.status });
};
