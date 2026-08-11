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
import {
  ChunkSchema,
  EmbeddingFactory,
  resolveEmbeddingConfig,
  isEmbeddingAuthError,
  getAtlasIndexForModel,
  FabFileChunkSearchIndex,
} from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { apiKeyService, embeddingCacheService, fabFilesService } from '@bike4mind/services';
import {
  finalizeBatchIfComplete,
  isBatchComplete,
  deferFailureIfRetryable,
} from '@server/queueHandlers/dataLakeBatchProgress';
import { FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT } from '@server/queueHandlers/sqsDelivery';
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

    // Only pass the credential the chosen provider needs. A missing one is not fatal here:
    // the factory surfaces it when an embed call is made, which is where the batch's
    // failure counters can record it. Bedrock needs none and authenticates via AWS.
    const { config: embeddingConfig } = resolveEmbeddingConfig(requiredProvider, apiKeyTable);

    const embeddingService = new EmbeddingFactory(embeddingConfig);

    const embeddingProvider = embeddingService.createEmbeddingService(embeddingModel);

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

    // Guards against a future Atlas index/chunk-vector width mismatch (e.g. a Voyage model
    // called with a non-default outputDimension): a chunk written at the wrong width would
    // silently corrupt that model's shared Atlas index once embeddingModel is stamped on it.
    // Validated up front, before any write is dispatched: throwing from inside the `.map()`
    // below would abort the transaction while sibling `update()` calls it already kicked off
    // are still in flight, leaving unhandled rejections racing the rollback.
    const expectedDimensions = getAtlasIndexForModel(embeddingModel)?.numDimensions;
    if (expectedDimensions !== undefined) {
      embeddableChunks.forEach((chunk, index) => {
        const vector = vectors[index];
        if (vector.length !== expectedDimensions) {
          throw new Error(
            `Chunk ${chunk.id} vector has ${vector.length} dimensions, expected ${expectedDimensions} for model ${embeddingModel}`
          );
        }
      });
    }

    // Write this message's chunk vectors in a transaction.
    await withTransaction(async () => {
      await Promise.all(
        embeddableChunks.map((chunk, index) => {
          chunk.vector = vectors[index];
          return fabFileChunkRepository.update(chunk);
        })
      );
    });

    // Self-host OpenSearch dual-write: outside the transaction (an OpenSearch write cannot be
    // rolled back with Mongo) and fail-open (an indexing failure leaves the chunk scan-only, not
    // failed - the Mongo write above already succeeded and is the source of truth).
    if (selfHostOpenSearchEnabled()) {
      try {
        // embeddingModel is NOT persisted per-chunk yet at this point - stampChunkEmbeddingModel
        // below writes it to Mongo in bulk, only once the whole file finishes. Setting it on
        // these in-memory objects is accurate right now regardless (this IS the model `vectors`
        // was generated with) and mapDocument requires it to build the right per-model index
        // document; it does not touch Mongo or the file-completion timing invariant.
        embeddableChunks.forEach(chunk => {
          chunk.embeddingModel = embeddingModel;
        });
        await FabFileChunkSearchIndex.indexChunks(embeddableChunks);
      } catch (error) {
        logger.warn(`Self-host OpenSearch indexing failed for FabFile ${fabFileId}, chunks remain scan-only`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Recompute vectorizedChunkCount from SOURCE (terminal = has-vector OR oversized)
    // rather than `+= validChunks.length`. With multiple vectorize messages per file,
    // an SQS redelivery of an already-processed message would otherwise double-count
    // and prematurely cross chunkCount. Recompute is idempotent.
    const vectorizedChunkCount = await fabFileChunkRepository.countTerminalChunks(fabFileId, contextWindow);
    const fabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
    if (!fabFile) throw new NotFoundError(`FabFile ${fabFileId} not found`);

    // >= with chunkCount>0 guard so an under-counted chunk can't permanently block completion.
    const isFileVectorized = !!fabFile.chunkCount && vectorizedChunkCount >= fabFile.chunkCount;

    if (isFileVectorized) {
      // Stamp every chunk with its embeddingModel only once the WHOLE file is vectorized - a
      // partial stamp mid-batch would let the Atlas cutover read path treat a still-vectorizing
      // file as ready. Folds the `vectorized: true` flip into the SAME transaction as the stamp:
      // writing it separately first would reopen the exact gap the stamp's own transaction
      // closes, just one level up - a crash between the two writes would mark the file vectorized
      // with no stamp, and the idempotency check below would then never retry it.
      await fabFilesService.stampChunkEmbeddingModel(
        fabFileId,
        embeddingModel,
        { db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository } },
        { vectorized: true, vectorizedChunkCount, isVectorizing: false }
      );
    } else {
      await fabFileRepository.update({
        id: fabFileId,
        vectorized: true,
        vectorizedChunkCount,
        isVectorizing: true,
      });
    }
    fabFile.vectorizedChunkCount = vectorizedChunkCount;
    fabFile.isVectorizing = !isFileVectorized;

    if (isFileVectorized) {
      // Non-fatal: a throw here must never reach the outer catch. This file is ALREADY
      // persisted vectorized:true above, so a deferred (non-final) retry would hit this
      // function's own idempotency early-return next attempt and skip straight past the
      // batch claim below - stranding the batch's vectorizedFiles forever instead of just
      // missing one UI push (a prior version of this bug: a human reviewer caught it).
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'update_file_chunk_vector_status',
        fabFileId,
        vectorizeStatus: 'complete',
      }).catch(err => logger.error(`Error notifying vectorize-complete for ${fabFileId}: ${err}`));

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
    // On the FINAL vectorization attempt, increment the batch's failedFiles counter so
    // the batch can transition out of 'processing' state when all files are accounted for.
    // Use atomic mark-failed to prevent double-counting on SQS retries. An earlier, non-final
    // attempt just logs and rethrows (see the gate below) - it may still succeed on retry.
    const errorMessage = err instanceof Error ? err.message : String(err);
    // The stored message surfaces to the end user on the file. An embedding-auth failure carries
    // operator instructions (set OPENAI_API_KEY / OLLAMA_BASE_URL) that a user can neither see nor
    // act on, so persist user-safe copy instead. The advice differs by file kind: a turn-attached
    // file falls back to its raw content in chat (see processFabFilesServer / canCosineSearch), so
    // it is still usable there; a data-lake file (batchId set) is retrieved only by cosine search
    // over its chunks, so with no vectors it is simply unfindable until re-indexed. The full
    // operator detail still goes to the logs below. Other failures (e.g. oversized chunk) keep
    // their specific, user-actionable message.
    const isAuthFailure = isEmbeddingAuthError(err);
    const storedError = isAuthFailure
      ? existingFabFile.batchId
        ? 'This file could not be indexed for semantic search because the embedding service was unavailable. It will not be found by knowledge search until it is re-indexed.'
        : 'This file could not be indexed for semantic search because the embedding service was unavailable. You can still ask about it directly in chat.'
      : errorMessage;
    if (isAuthFailure) {
      logger.warn(`Vectorization failed for ${fabFileId} (embedding auth): ${errorMessage}`);
    }

    // Only account a failure into the batch/file state on the LAST SQS delivery attempt -
    // see deferFailureIfRetryable's doc comment for why an earlier attempt must leave
    // 'failed' status untouched.
    if (
      await deferFailureIfRetryable(event, FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT, {
        fabFileId,
        batchId: existingFabFile.batchId,
        action: 'Vectorization',
        errorMessage,
        logger,
      })
    ) {
      throw err; // Re-throw so SQS retries
    }

    // markFailedIfNotAlready is the file-level idempotency guard: only the first
    // failure increments the counter, so SQS redelivery of a failed message is a no-op.
    const isFirstFailure = await fabFileRepository.markFailedIfNotAlready(fabFileId, storedError);
    if (existingFabFile.batchId && isFirstFailure) {
      try {
        await dataLakeBatchRepository.updateFileStatus(existingFabFile.batchId, fabFileId, 'failed', storedError);
        // One atomic $inc for both counters - two sequential incrementCounter calls could
        // leave failedFiles bumped without processingFailedFiles on a crash between them,
        // misclassifying this as an upload failure with no automatic recovery (#1412).
        const batch = await dataLakeBatchRepository.incrementCounters(existingFabFile.batchId, {
          failedFiles: 1,
          processingFailedFiles: 1,
        });
        await finalizeBatchIfComplete(batch, logger);

        const isComplete = isBatchComplete(batch);
        await sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'data_lake_batch_progress',
          batchId: existingFabFile.batchId,
          failedFiles: batch?.failedFiles ?? 1,
          processingFailedFiles: batch?.processingFailedFiles ?? 1,
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
