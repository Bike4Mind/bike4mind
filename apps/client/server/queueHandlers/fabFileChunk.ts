import {
  adminSettingsRepository,
  dataLakeBatchRepository,
  fabFileChunkRepository,
  fabFileRepository,
  FabFile,
  User,
  withTransaction,
} from '@bike4mind/database';
import { sendToClient } from '@server/websocket/utils';
import { z } from 'zod';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { sendToQueue } from '@server/utils/sqs';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { finalizeBatchIfComplete, isBatchComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Resource } from 'sst';

const ChunkFabFilePayload = z.object({
  fabFileId: z.string(),
  userId: z.string(),
  chunkSize: z.coerce.number().optional(),
});

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { fabFileId, userId } = ChunkFabFilePayload.parse(JSON.parse(body));

  const user = await User.findById(userId);
  if (!user) throw new Error(`User not found for userId: ${userId}`);

  logger.updateMetadata({
    fabFileId,
    userId,
  });

  logger.log('====================================');
  logger.log(`Started chunk queue handler for fabFileId: ${fabFileId}`);
  logger.log('====================================');

  const defaultEmbeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) {
    throw new BadRequestError('Default embedding model not found');
  }

  const fabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) {
    logger.log(`FabFile not found: ${fabFileId}, skipping chunking`);
    return;
  }

  // Mark the file as actively chunking so the self-host safety-net scan (worker) doesn't
  // re-enqueue it mid-run - a duplicate would re-chunk and re-embed the whole file. Cleared
  // in `finally` on success AND failure so it can still be retried/reprocessed. Default: false.
  await FabFile.updateOne({ _id: fabFileId }, { $set: { isChunking: true } });

  try {
    // Tag data-lake chunk logs with the batch id for incident triage (the lake is derivable
    // from the batch). dataLakeId isn't on the FabFile and isn't worth an extra read here.
    if (fabFile.batchId) logger.updateMetadata({ batchId: fabFile.batchId });

    const fabFileChunks = await withTransaction(async () =>
      fabFilesService.chunkFabfile(
        user,
        {
          fabFileId,
          embeddingModel: defaultEmbeddingModel,
        },
        {
          db: {
            fabFiles: fabFileRepository,
            fabFileChunks: fabFileChunkRepository,
            users: User,
          },
          storage: {
            getContentAsBuffer: (filePath: string) => {
              return getFilesStorage().getContentAsBuffer(filePath);
            },
          },
          logger,
        }
      )
    ).catch(async (err: unknown) => {
      // chunkFabfile can throw on a genuinely bad file (e.g. a corrupt PDF). Without this,
      // the file would sit at chunkCount:0 with no error - visually identical to a
      // silently-dropped record. Persist a per-file error and account it as failed in its
      // batch (so the batch still reaches a terminal state), mirroring fabFileVectorize's
      // failure handling, then re-throw so SQS retries then routes to the DLQ.
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isFirstFailure = await fabFileRepository.markFailedIfNotAlready(fabFileId, errorMessage);
      if (fabFile.batchId && isFirstFailure) {
        try {
          await dataLakeBatchRepository.updateFileStatus(fabFile.batchId, fabFileId, 'failed', errorMessage);
          const batch = await dataLakeBatchRepository.incrementCounter(fabFile.batchId, 'failedFiles');
          await finalizeBatchIfComplete(batch, logger);
          await sendToClient(userId, Resource.websocket.managementEndpoint, {
            action: 'data_lake_batch_progress',
            batchId: fabFile.batchId,
            failedFiles: batch?.failedFiles ?? 1,
            status: isBatchComplete(batch)
              ? batch!.failedFiles > 0
                ? 'completed_with_errors'
                : 'completed'
              : undefined,
          });
        } catch (innerErr) {
          logger.error(`Error reporting batch chunk failure: ${innerErr}`);
        }
      }
      throw err;
    });

    logger.updateMetadata({
      fabFileChunksCount: fabFileChunks.length,
    });

    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'update_file_chunk_vector_status',
      fabFileId,
      chunkStatus: 'complete',
      vectorizeStatus: 'ongoing',
    });

    // Track batch progress if file belongs to a data lake batch.
    // Reuse the fabFile loaded earlier - batchId is set on upload and doesn't change.
    // Atomic claim (uploaded/pending -> chunking) gates the increment so a redelivered
    // chunk message doesn't double-count.
    if (fabFile.batchId) {
      try {
        const claimed = await dataLakeBatchRepository.claimFileStatus(
          fabFile.batchId,
          fabFileId,
          ['uploaded', 'pending'],
          'chunking'
        );
        if (claimed) {
          const updatedBatch = await dataLakeBatchRepository.incrementCounter(fabFile.batchId, 'chunkedFiles');
          await sendToClient(userId, Resource.websocket.managementEndpoint, {
            action: 'data_lake_batch_progress',
            batchId: fabFile.batchId,
            chunkedFiles: updatedBatch?.chunkedFiles ?? 1,
          });
        }
      } catch (error) {
        logger.error(`Error updating batch chunk progress: ${error}`);
      }
    }

    if (fabFileChunks.length === 0) {
      logger.log('No chunks to vectorize');
      // Hardening: a 0-chunk result is indistinguishable from a genuinely-empty
      // file, but it's usually a failed/partial extraction (e.g. image-only or a
      // parser-unfriendly .docx). Flag it on the fabFile so it's visible/queryable
      // instead of silently completing. We still close the batch below so it
      // doesn't hang.
      logger.log(`fabFile ${fabFileId} produced 0 chunks - no extractable text`);
      await FabFile.updateOne(
        { _id: fabFileId },
        { $set: { notes: 'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).' } }
      ).catch(err => logger.error(`Failed to flag zero-chunk fabFile ${fabFileId}: ${err}`));
      // A zero-chunk file (empty / unparseable) produces no vectorize message, so it
      // would never reach a terminal batch counter and the batch would hang until the
      // reconciler. Account for it as complete here so batch math closes immediately.
      if (fabFile.batchId) {
        try {
          const claimed = await dataLakeBatchRepository.claimFileStatus(
            fabFile.batchId,
            fabFileId,
            ['chunking', 'uploaded', 'pending'],
            'complete'
          );
          if (claimed) {
            const batch = await dataLakeBatchRepository.incrementCounter(fabFile.batchId, 'vectorizedFiles');
            await finalizeBatchIfComplete(batch, logger);
            await sendToClient(userId, Resource.websocket.managementEndpoint, {
              action: 'data_lake_batch_progress',
              batchId: fabFile.batchId,
              vectorizedFiles: batch?.vectorizedFiles ?? 1,
              status: isBatchComplete(batch)
                ? batch!.failedFiles > 0
                  ? 'completed_with_errors'
                  : 'completed'
                : undefined,
            });
          }
        } catch (error) {
          logger.error(`Error finalizing zero-chunk file in batch: ${error}`);
        }
      }
      return;
    }

    const queueUrl = Resource.fabFileVectorizeQueue.url;
    if (!queueUrl) throw new Error('Vectorize queue URL not found');

    // Target batch size: aim for ~50 chunks or ~100K tokens per batch (conservative)
    const BATCH_SIZE = 50;
    const batches: (typeof fabFileChunks)[] = [];

    for (let i = 0; i < fabFileChunks.length; i += BATCH_SIZE) {
      batches.push(fabFileChunks.slice(i, i + BATCH_SIZE));
    }

    logger.updateMetadata({ batchCount: batches.length });

    // Only send chunk IDs (not full chunks) to avoid exceeding SQS 256KB message limit
    await Promise.all(
      batches.map(async batch => {
        await sendToQueue(queueUrl, {
          fabFileId,
          chunkIds: batch.map(c => c.id),
          userId,
          embeddingModel: defaultEmbeddingModel,
          batchSize: batch.length,
        });
      })
    );

    logger.log(`Sent ${batches.length} batches to vectorize queue`);
    logger.log('====================================');
    logger.log('Completed chunk queue handler');
    logger.log('====================================');
  } finally {
    await FabFile.updateOne({ _id: fabFileId }, { $set: { isChunking: false } }).catch(err =>
      logger.error(`Failed to clear isChunking for ${fabFileId}: ${err}`)
    );
  }
});
