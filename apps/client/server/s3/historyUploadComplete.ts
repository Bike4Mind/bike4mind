import { IChatHistoryItem, InboxType, ISession } from '@bike4mind/common';
import { importHistoryService } from '@bike4mind/services';
import { S3Storage } from '@bike4mind/fab-pipeline';
import {
  inboxRepository,
  Quest,
  sessionRepository,
  User,
  withTransaction,
  importHistoryJobRepository,
} from '@bike4mind/database';
import { withContext } from '@server/s3/utils';
import { Resource } from 'sst';
import { updateImportProgress, markImportComplete, markImportFailed } from '@server/utils/importHistoryProgress';

const importHistory = async (
  userId: string,
  source: importHistoryService.ImportSource,
  zipFile: string,
  importHistoryJobId: string
) => {
  return await importHistoryService.importHistory(
    {
      source,
      userId,
      zipFile,
    },
    {
      db: {
        withTransaction,
        sessions: {
          upsertByOpenaiConversationId: (openaiConversationId: string, update: Partial<ISession>) => {
            return sessionRepository.upsertByOpenaiConversationId(openaiConversationId, update);
          },
          upsertByClaudeConversationId: (claudeConversationId: string, update: Partial<ISession>) => {
            return sessionRepository.upsertByClaudeConversationId(claudeConversationId, update);
          },
        },
        chatHistoryItems: {
          bulkCreate: async (data: IChatHistoryItem[]) => {
            await Quest.bulkWrite(
              data.map(r => ({
                updateOne: {
                  filter: {
                    sessionId: r.sessionId,
                    openaiMessageId: r.openaiMessageId ?? undefined,
                    claudeMessageId: r.claudeMessageId ?? undefined,
                  },
                  update: { $set: r },
                  upsert: true,
                },
              }))
            );
          },
        },
        users: {
          findById: (id: string) => User.findById(id),
        },
      },
      onProgress: async (progress: number, currentStep: string, processed: number, total: number) => {
        await updateImportProgress(importHistoryJobId, userId, {
          progress,
          currentStep,
          processedItems: processed,
          totalItems: total,
        });
      },
    }
  );
};

export const dispatch = withContext(async (event, context, logger) => {
  if (!event.Records || event.Records.length === 0) {
    logger.error('No records found');
    return;
  }

  for (const record of event.Records) {
    if (!record.s3) {
      logger.error('No S3 record found');
      continue;
    }

    if (record.s3.bucket.name !== Resource.historyImportBucket.name) {
      logger.error(`Invalid bucket: ${record.s3.bucket.name}`);
      continue;
    }

    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')); // Decode URL-encoded key
    const [userId, ...splitKey] = key.split('/');
    let [source, file] = splitKey as [importHistoryService.ImportSource, string | undefined];
    // Older import keys lack a source segment; default to OPENAI if this looks like one.
    if (
      !file &&
      !Object.values(importHistoryService.ImportSource).includes(source as importHistoryService.ImportSource)
    ) {
      file = source as string;
      source = importHistoryService.ImportSource.OPENAI;
    }

    const missing = [!userId && 'userId', !source && 'source', !file && 'file'].filter(Boolean);
    if (missing.length > 0) {
      console.error(`Invalid key: ${key}, missing ${missing.join(', ')}`);
      continue;
    }

    try {
      logger.info(`Handling history import for ${key}`);
      logger.info(`Full S3 URL: s3://${bucket}/${key}`);
      logger.info(`Bucket: ${bucket}, Key: ${key}, UserId: ${userId}, Source: ${source}`);

      // Check if file still exists (idempotency - handle duplicate S3 events)
      const s3 = new S3Storage(bucket);
      let fileSize: number;
      try {
        const metadata = await s3.getMetadata(key);
        fileSize = metadata.size ?? 0;
      } catch (err: any) {
        if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
          logger.info(`File ${key} already processed (doesn't exist), skipping duplicate event`);
          return; // File already processed by another invocation
        }
        throw err;
      }

      // Check for existing job by S3 key (idempotency)
      let importJob;
      const existingJob = await importHistoryJobRepository.findByS3Key(key);
      if (existingJob) {
        // Allow reprocessing if the job is pending (indicates a retry)
        if (existingJob.status === 'pending') {
          logger.info(`Job ${existingJob.id} is pending retry, continuing processing`);
          importJob = existingJob;
        } else {
          logger.info(`Job already exists for ${key} with status ${existingJob.status}, skipping duplicate event`);
          return;
        }
      } else {
        // Check for active imports (concurrency control) - only for new imports
        const hasActiveImport = await importHistoryJobRepository.hasActiveImport(userId);
        if (hasActiveImport) {
          logger.info(`User ${userId} already has an active import, skipping`);
          await inboxRepository.createInboxMessage({
            type: InboxType.COMMON,
            title: 'Import Already in Progress',
            message: `You already have an import in progress. Please wait for it to complete before starting a new one.`,
            receiverId: userId,
            userId,
          });
          return;
        }

        importJob = await importHistoryJobRepository.create({
          userId,
          source,
          s3Bucket: bucket,
          s3Key: key,
          fileSize,
          status: 'pending',
          progress: 0,
          currentStep: 'Starting import...',
          totalItems: 0,
          processedItems: 0,
          skippedItems: 0,
          failedItems: 0,
        });

        logger.info(`Created import job ${importJob.id} for user ${userId}`);
      }

      // Mark as processing and start import
      await importHistoryJobRepository.update({
        id: importJob.id,
        status: 'processing',
        startedAt: new Date(),
        currentStep: 'Downloading and extracting file...',
      });

      await importHistory(userId, source, `s3://${bucket}/${key}`, importJob.id);

      // If successfully processed, mark complete and delete the S3 file
      await markImportComplete(importJob.id, userId, {
        processedItems: importJob.totalItems,
        skippedItems: 0,
      });

      await Promise.all([
        s3.delete(key),
        inboxRepository.createInboxMessage({
          type: InboxType.COMMON,
          title: 'LLM historical data import Succeeded',
          message: `Your ${source} data import is done!`,
          receiverId: userId,
          userId,
        }),
      ]);
    } catch (err) {
      logger.error(err);

      // Try to get the import job ID from the key to mark it as failed
      try {
        const existingJob = await importHistoryJobRepository.findByS3Key(key);
        if (existingJob) {
          await markImportFailed(existingJob.id, userId, {
            message: err instanceof Error ? err.message : 'Unknown error',
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      } catch (markFailedErr) {
        logger.error('Failed to mark import as failed:', markFailedErr);
      }

      await inboxRepository.createInboxMessage({
        type: InboxType.COMMON,
        title: 'LLM history import Failed',
        message: `Your ${source} import failed, please try again later and/or contact support`,
        receiverId: userId,
        userId,
      });
    }
  }
});
