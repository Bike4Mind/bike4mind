import { InboxType, isImageServeable } from '@bike4mind/common';
import { notebookImportService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { S3Storage } from '@bike4mind/fab-pipeline';
import {
  inboxRepository,
  sessionRepository,
  questRepository,
  Quest,
  FabFile,
  Artifact,
  Agent,
  Tool,
  User,
  withTransaction,
  importHistoryJobRepository,
} from '@bike4mind/database';
import { withContext } from '@server/s3/utils';
import { Resource } from 'sst';
import { getFilesStorage } from '@server/utils/storage';
import { v4 as uuidv4 } from 'uuid';
import { updateImportProgress, markImportComplete, markImportFailed } from '@server/utils/importHistoryProgress';

const { NotebookImportService } = notebookImportService;

const processNotebookImport = async (
  userId: string,
  dataKey: string,
  optionsKey: string,
  bucket: string,
  logger: Logger,
  importHistoryJobId: string
) => {
  return withTransaction(async session => {
    const s3 = new S3Storage(bucket);

    try {
      const [importDataBuffer, optionsBuffer] = await Promise.all([
        s3.getContentAsBuffer(dataKey),
        s3.getContentAsBuffer(optionsKey),
      ]);

      const importData = JSON.parse(importDataBuffer.toString('utf-8'));
      const options = JSON.parse(optionsBuffer.toString('utf-8'));

      logger.info('Processing notebook import', {
        userId,
        dataKey,
        notebookCount: importData.notebooks?.length || 0,
        options,
      });

      // Create service adapters (matching the export service pattern)
      const adapters = {
        sessionRepository: {
          ...sessionRepository,
          ctx: session,
          create: async (data: any) => {
            sessionRepository.ctx = session;
            return sessionRepository.create(data);
          },
          find: async (query: any) => {
            sessionRepository.ctx = session;
            return sessionRepository.find(query);
          },
          updateById: async (id: string, data: any) => {
            // sessionRepository.update expects the full object with _id
            sessionRepository.ctx = session;
            return sessionRepository.update({ _id: id, ...data });
          },
        },
        chatHistoryRepository: {
          ...questRepository,
          ctx: session,
          bulkCreate: async (items: any[]) => {
            // Use Quest model directly for bulk operations
            const bulkOps = items.map(item => ({
              updateOne: {
                filter: { _id: item.id },
                update: { $set: item },
                upsert: true,
              },
            }));
            return Quest.bulkWrite(bulkOps, { session });
          },
          deleteMany: async (filter: any) => {
            return Quest.deleteMany(filter).session(session);
          },
        },
        knowledgeRepository: {
          create: async (data: any) => {
            // Use model directly with session for transaction support
            const [created] = await FabFile.create([data], { session });
            return created;
          },
        },
        artifactRepository: {
          create: async (data: any) => {
            // Use model directly with session for transaction support
            const [created] = await Artifact.create([data], { session });
            return created;
          },
        },
        toolRepository: {
          find: async (query: any) => Tool.find(query).session(session),
          findById: async (id: string) => Tool.findById(id).session(session),
          create: async (data: any) => {
            const [created] = await Tool.create([data], { session });
            return created;
          },
        },
        agentRepository: {
          create: async (data: any) => {
            // Use model directly with session for transaction support
            const [created] = await Agent.create([data], { session });
            return created;
          },
        },
        userRepository: {
          findById: async (id: string) => User.findById(id).session(session),
        },
        fileStorageService: {
          getFileContent: async (path: string) => {
            try {
              // This adapter has no live caller today (copyFileFromUrl(), the only call
              // site that would need it, is an unimplemented stub that just returns the
              // source URL unchanged), but it reads raw bytes from a storage path with no
              // moderation check. Gate defensively so a future implementation of
              // copyFileFromUrl() can't leak a held/blocked uploaded image's bytes. No
              // FabFile match (e.g. a non-fabfile asset) falls through unaffected.
              const fabFile = await FabFile.findOne({ filePath: path }).session(session);
              if (fabFile && !isImageServeable(fabFile)) {
                logger.warn('Refusing to read content for unmoderated image', { path });
                return null;
              }
              const buffer = await getFilesStorage().getContentAsBuffer(path);
              return buffer.toString('base64');
            } catch (error) {
              logger.warn('Failed to get file content', { path, error });
              return null;
            }
          },
          uploadFile: async (path: string, content: Buffer) => {
            await getFilesStorage().upload(content, path);
          },
          getSignedUrl: async (path: string, expiresIn = 3600) => {
            try {
              // Same dead-today, defensive gate as getFileContent above: mirrors
              // fabFileService/get.ts by withholding the signed URL for a held/blocked
              // uploaded image.
              const fabFile = await FabFile.findOne({ filePath: path }).session(session);
              if (fabFile && !isImageServeable(fabFile)) {
                logger.warn('Refusing to mint signed URL for unmoderated image', { path });
                return null;
              }
              return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn });
            } catch (error) {
              logger.warn('Failed to get signed URL', { path, error });
              return null;
            }
          },
        },
        logger,
        generateId: () => uuidv4(),
        onProgress: async (progress: number, currentStep: string, processed: number, total: number) => {
          await updateImportProgress(importHistoryJobId, userId, {
            progress,
            currentStep,
            processedItems: processed,
            totalItems: total,
          });
        },
      };

      const importService = new NotebookImportService(adapters);
      const result = await importService.importNotebooks(userId, importData, options);

      await markImportComplete(importHistoryJobId, userId, {
        processedItems: result.importedNotebooks + result.importedMessages,
        skippedItems: result.skippedNotebooks,
      });

      await inboxRepository.createInboxMessage({
        type: InboxType.COMMON,
        title: '✅ Notebook Import Successful',
        message: `Successfully imported ${result.importedNotebooks} notebook(s) with ${result.importedMessages} messages. ${
          result.skippedNotebooks > 0 ? `Skipped ${result.skippedNotebooks} duplicate(s).` : ''
        }`,
        receiverId: userId,
        userId,
      });

      logger.info('Notebook import completed successfully', { userId, result });
      return result;
    } catch (error) {
      logger.error('Notebook import failed', { userId, dataKey, error });

      await markImportFailed(importHistoryJobId, userId, {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      await inboxRepository.createInboxMessage({
        type: InboxType.COMMON,
        title: '❌ Notebook Import Failed',
        message: `Failed to import notebooks. Error: ${
          error instanceof Error ? error.message : 'Unknown error'
        }. Please try again or contact support if the issue persists.`,
        receiverId: userId,
        userId,
      });

      throw error;
    } finally {
      await Promise.all([
        s3.delete(dataKey).catch(err => logger.warn('Failed to delete data file', { dataKey, error: err })),
        s3.delete(optionsKey).catch(err => logger.warn('Failed to delete options file', { optionsKey, error: err })),
      ]);
    }
  });
};

export const dispatch = withContext(async (event, context, logger) => {
  if (!event.Records || event.Records.length === 0) {
    logger.error('No records found in S3 event');
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
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Only process notebook imports (skip options files)
    if (!key.startsWith('notebooks/') || key.endsWith('.options.json')) {
      logger.debug('Skipping non-notebook or options file', { key });
      continue;
    }

    const [, userId, filename] = key.split('/'); // prefix not used
    const timestamp = filename?.split('.')[0];

    if (!userId || !timestamp) {
      logger.error('Invalid key format', { key });
      continue;
    }

    const optionsKey = `notebooks/${userId}/${timestamp}.options.json`;

    try {
      logger.info('Processing notebook import', { key, optionsKey });

      const s3 = new S3Storage(bucket);
      let fileSize: number;
      try {
        const metadata = await s3.getMetadata(key);
        fileSize = metadata.size ?? 0;
      } catch (err: any) {
        if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
          logger.info(`File ${key} already processed (doesn't exist), skipping duplicate event`);
          continue;
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
          continue;
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
          continue;
        }

        importJob = await importHistoryJobRepository.create({
          userId,
          source: 'Notebook',
          s3Bucket: bucket,
          s3Key: key,
          fileSize,
          status: 'pending',
          progress: 0,
          currentStep: 'Starting notebook import...',
          totalItems: 0,
          processedItems: 0,
          skippedItems: 0,
          failedItems: 0,
        });

        logger.info(`Created import job ${importJob.id} for user ${userId}`);
      }

      await importHistoryJobRepository.update({
        id: importJob.id,
        status: 'processing',
        startedAt: new Date(),
        currentStep: 'Loading notebook data...',
      });

      await processNotebookImport(userId, key, optionsKey, bucket, logger, importJob.id);
    } catch (error) {
      logger.error('Failed to process notebook import', {
        key,
        userId,
        error,
      });

      try {
        const existingJob = await importHistoryJobRepository.findByS3Key(key);
        if (existingJob && existingJob.status !== 'failed') {
          await markImportFailed(existingJob.id, userId, {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      } catch (markFailedErr) {
        logger.error('Failed to mark import as failed:', markFailedErr);
      }
    }
  }
});
