import { SupportedEmbeddingModelSchema } from '@bike4mind/common';
import { getVector } from '@server/managers/fabFileManager';
import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeBatchRepository,
  embeddingCacheRepository,
  fabFileChunkRepository,
  fabFileRepository,
  User,
  withTransaction,
} from '@bike4mind/database';
import { NotFoundError } from '@server/utils/errors';
import { sendToClient } from '@server/websocket/utils';
import { z } from 'zod';
import { ChunkSchema, EmbeddingFactory } from '@bike4mind/fab-pipeline';
import { apiKeyService, embeddingCacheService } from '@bike4mind/services';
import { finalizeBatchIfComplete, isBatchComplete } from '@server/queueHandlers/dataLakeBatchProgress';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getSettingsByNames } from '@bike4mind/utils';
import { getProviderFromModel } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

const VectorizePayload = z.object({
  chunkId: z.string().optional(),
  chunk: ChunkSchema.optional(),
  chunkIds: z.array(z.string()).optional(),
  userId: z.string(),
  fabFileId: z.string(),
  embeddingModel: SupportedEmbeddingModelSchema,
  batchSize: z.number().optional(),
});

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const payload = VectorizePayload.parse(JSON.parse(body));
  const { userId, fabFileId, embeddingModel } = payload;

  // Support both single chunk (backward compat) and batch processing
  const isBatch = payload.chunkIds && payload.chunkIds.length > 0;
  const chunkIds = isBatch ? payload.chunkIds! : [payload.chunkId!];

  // Runtime validation for embedding model
  if (!embeddingModel || typeof embeddingModel !== 'string') {
    throw new Error(`Invalid embedding model: ${embeddingModel}`);
  }

  logger.updateMetadata({
    chunkIds: isBatch ? chunkIds : chunkIds[0],
    userId,
    fabFileId,
    batchSize: chunkIds.length,
  });

  logger.log('====================================');
  logger.log(
    `Started fab file generate embeddings queue handler (${isBatch ? 'BATCH' : 'single'} mode, ${chunkIds.length} chunks)`
  );
  logger.log('====================================');

  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const existingFabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
  if (!existingFabFile) {
    logger.log(`FabFile not found: ${fabFileId}, skipping vectorization`);
    return;
  }

  // Tag data-lake vectorize logs with the batch id for incident triage (the lake is derivable
  // from the batch). dataLakeId isn't on the FabFile and isn't worth an extra read here.
  if (existingFabFile.batchId) logger.updateMetadata({ batchId: existingFabFile.batchId });

  // Idempotency: if the file is already fully vectorized, this is a duplicate SQS delivery.
  // Skip to avoid double-counting batch counters. (Per CLAUDE.md - queue handlers must be idempotent.)
  if (
    existingFabFile.vectorized &&
    existingFabFile.chunkCount &&
    existingFabFile.vectorizedChunkCount === existingFabFile.chunkCount
  ) {
    logger.log(`FabFile ${fabFileId} already vectorized, skipping duplicate message`);
    return;
  }

  const fabFileChunks = await Promise.all(chunkIds.map(id => fabFileChunkRepository.findById(id)));

  const validChunks = fabFileChunks.filter((chunk, index): chunk is NonNullable<typeof chunk> => {
    if (!chunk) {
      logger.log(`FabFileChunk not found: ${chunkIds[index]} for FabFile ${fabFileId}, skipping`);
      return false;
    }
    return true;
  });

  if (validChunks.length === 0) {
    logger.log('No valid chunks to vectorize');
    return;
  }

  logger.log(`Processing ${validChunks.length} valid chunks`);

  // Wrap main processing in try/catch so batch failure counters get updated.
  // Without this, batches with failures hang in 'processing' forever because the
  // completion check (vectorizedFiles + failedFiles >= totalFiles) never fires.
  try {
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
      userId,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
      { logger }
    );

    const requiredProvider = getProviderFromModel(embeddingModel);

    // Only pass the API key for the provider that will be used
    const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};

    if (requiredProvider === 'openai') {
      embeddingConfig.openaiApiKey = apiKeyTable?.openai;
    } else if (requiredProvider === 'voyageai') {
      embeddingConfig.voyageApiKey = apiKeyTable?.voyageai;
    }

    // Bedrock doesn't need API keys as it uses AWS credentials

    const embeddingService = new EmbeddingFactory(embeddingConfig);

    const embeddingProvider = embeddingService.createEmbeddingService(embeddingModel as any);

    // Pre-flight: filter out chunks that exceed the model's context window.
    // These cannot be embedded and would cause the entire batch to fail.
    // Chunks stored before chunking fixes may have this issue.
    const { contextWindow } = embeddingProvider.getModelInfo();
    const embeddableChunks = validChunks.filter(chunk => {
      if (chunk.tokenCount > contextWindow) {
        logger.warn(
          `Chunk ${chunk.id} skipped: tokenCount ${chunk.tokenCount} exceeds model context window ${contextWindow}. ` +
            `This chunk will not be searchable. Re-upload the file to re-chunk it correctly.`
        );
        return false;
      }
      return true;
    });

    const skippedCount = validChunks.length - embeddableChunks.length;
    if (skippedCount > 0) {
      logger.warn(`Skipped ${skippedCount} oversized chunk(s) out of ${validChunks.length} total`);
    }

    const texts = embeddableChunks.map(chunk => chunk.text);
    const tokenCounts = embeddableChunks.map(chunk => chunk.tokenCount);

    logger.log(`Generating embeddings for ${texts.length} texts (checking cache first)`);

    const cacheChecks = await Promise.all(
      texts.map(text => embeddingCacheService.getEmbedding(text, embeddingModel, { cache: embeddingCacheRepository }))
    );

    const cacheMisses: Array<{ index: number; text: string; tokenCount: number }> = [];
    const vectors: number[][] = new Array(texts.length);

    cacheChecks.forEach((cached, index) => {
      if (cached) {
        vectors[index] = cached;
      } else {
        cacheMisses.push({ index, text: texts[index], tokenCount: tokenCounts[index] });
      }
    });

    const cacheHitCount = texts.length - cacheMisses.length;
    logger.log(`Cache hits: ${cacheHitCount}/${texts.length}, generating ${cacheMisses.length} new embeddings`);

    if (cacheMisses.length > 0) {
      const missTexts = cacheMisses.map(m => m.text);
      const missTokenCounts = cacheMisses.map(m => m.tokenCount);

      let newVectors: number[][];
      if (missTexts.length === 1) {
        // Single chunk: use single embedding method
        const vector = await getVector(embeddingProvider, missTexts[0]);
        newVectors = [vector];
      } else {
        // Multiple chunks: use batch method
        if (
          'generateEmbeddingBatch' in embeddingProvider &&
          typeof embeddingProvider.generateEmbeddingBatch === 'function'
        ) {
          newVectors = await (
            embeddingProvider.generateEmbeddingBatch as (texts: string[], tokenCounts?: number[]) => Promise<number[][]>
          )(missTexts, missTokenCounts);
        } else {
          // Fallback for providers without batch support
          logger.log('Provider does not support batch embedding, falling back to individual calls');
          newVectors = await Promise.all(missTexts.map(text => getVector(embeddingProvider, text)));
        }
      }

      await Promise.all(
        cacheMisses.map(async (miss, i) => {
          vectors[miss.index] = newVectors[i];
          // Store in cache (fire and forget)
          embeddingCacheService
            .setEmbedding(miss.text, embeddingModel, newVectors[i], miss.tokenCount, {
              cache: embeddingCacheRepository,
            })
            .catch(error => {
              logger.log(`Warning: Failed to cache embedding: ${error}`);
            });
        })
      );
    }

    logger.log(`Successfully generated embeddings: ${cacheHitCount} from cache, ${cacheMisses.length} newly generated`);

    // Write this message's chunk vectors in a transaction.
    await withTransaction(async () => {
      await Promise.all(
        embeddableChunks.map((chunk, index) => {
          chunk.vector = vectors[index];
          return fabFileChunkRepository.update(chunk);
        })
      );
    });

    // Recompute vectorizedChunkCount from SOURCE (terminal = has-vector OR oversized)
    // rather than `+= validChunks.length`. With multiple vectorize messages per file,
    // an SQS redelivery of an already-processed message would otherwise double-count
    // and prematurely cross chunkCount. Recompute is idempotent.
    const vectorizedChunkCount = await fabFileChunkRepository.countTerminalChunks(fabFileId, contextWindow);
    const fabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
    if (!fabFile) throw new NotFoundError(`FabFile ${fabFileId} not found`);

    // >= with chunkCount>0 guard so an under-counted chunk can't permanently block completion.
    const isFileVectorized = !!fabFile.chunkCount && vectorizedChunkCount >= fabFile.chunkCount;
    await fabFileRepository.update({
      id: fabFileId,
      vectorized: true,
      vectorizedChunkCount,
      isVectorizing: !isFileVectorized,
    });
    fabFile.vectorizedChunkCount = vectorizedChunkCount;
    fabFile.isVectorizing = !isFileVectorized;

    if (isFileVectorized) {
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'update_file_chunk_vector_status',
        fabFileId,
        vectorizeStatus: 'complete',
      });

      // Track batch progress if file belongs to a data lake batch.
      // Atomic claim gates the increment so a redelivered "complete" message is a no-op.
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

            const isComplete = isBatchComplete(batch);
            await sendToClient(userId, Resource.websocket.managementEndpoint, {
              action: 'data_lake_batch_progress',
              batchId: fabFile.batchId,
              vectorizedFiles: batch?.vectorizedFiles ?? 1,
              status: isComplete ? (batch!.failedFiles > 0 ? 'completed_with_errors' : 'completed') : undefined,
            });
          }
        } catch (error) {
          logger.error(`Error updating batch vectorize progress: ${error}`);
        }
      }
    }

    // update file error
    if (fabFile?.error?.startsWith('Knowledge in the workbench with the fileName')) {
      await fabFileRepository.update({ id: fabFileId, error: null });
    }
  } catch (err) {
    // On vectorization failure, increment the batch's failedFiles counter so
    // the batch can transition out of 'processing' state when all files are accounted for.
    // Use atomic mark-failed to prevent double-counting on SQS retries.
    const errorMessage = err instanceof Error ? err.message : String(err);
    // markFailedIfNotAlready is the file-level idempotency guard: only the first
    // failure increments the counter, so SQS redelivery of a failed message is a no-op.
    const isFirstFailure = await fabFileRepository.markFailedIfNotAlready(fabFileId, errorMessage);
    if (existingFabFile.batchId && isFirstFailure) {
      try {
        await dataLakeBatchRepository.updateFileStatus(existingFabFile.batchId, fabFileId, 'failed', errorMessage);
        const batch = await dataLakeBatchRepository.incrementCounter(existingFabFile.batchId, 'failedFiles');
        await finalizeBatchIfComplete(batch, logger);

        const isComplete = isBatchComplete(batch);
        await sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'data_lake_batch_progress',
          batchId: existingFabFile.batchId,
          failedFiles: batch?.failedFiles ?? 1,
          status: isComplete ? (batch!.failedFiles > 0 ? 'completed_with_errors' : 'completed') : undefined,
        });
      } catch (innerErr) {
        logger.error(`Error reporting batch failure: ${innerErr}`);
      }
    }
    throw err; // Re-throw so SQS marks the message failed
  }

  logger.log('====================================');
  logger.log('Completed fab file generate embeddings queue handler');
  logger.log('====================================');
});
