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
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { getFilesStorage } from '@server/utils/storage';
import { sendToQueue } from '@server/utils/sqs';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  finalizeBatchIfComplete,
  isBatchComplete,
  deferFailureIfRetryable,
} from '@server/queueHandlers/dataLakeBatchProgress';
import { FAB_FILE_CHUNK_MAX_RECEIVE_COUNT } from '@server/queueHandlers/sqsDelivery';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { NO_EXTRACTABLE_TEXT_NOTE_PREFIX } from '@server/worker/chunkScan';
import { Resource } from 'sst';
import type { SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';

const ChunkFabFilePayload = z.object({
  fabFileId: z.string(),
  userId: z.string(),
  // Optional soft chunk-size override in TOKENS, forwarded to the chunker as its passage
  // target. Historically this field was sent but silently ignored (whole documents became
  // single context-window-sized chunks - #1420); most producers now omit it and rely on
  // the chunker's passage-granularity default. `.catch(undefined)` fails soft: a malformed
  // value from a legacy or hand-crafted message falls back to the default instead of turning
  // the whole message into a DLQ poison pill.
  chunkSize: z.coerce.number().int().positive().optional().catch(undefined),
});

/** Target batch size: aim for ~50 chunks or ~100K tokens per vectorize message (conservative). */
const VECTORIZE_BATCH_SIZE = 50;

/**
 * Prefix of the error this handler stores when the vectorize hand-off fails. Load-bearing: the
 * resume path clears the file's `error` only when it owns it, so a real chunking/vectorizing
 * error from elsewhere is never wiped by a successful re-enqueue.
 */
const VECTORIZE_ENQUEUE_ERROR_PREFIX = 'Could not hand off for vector indexing';

const vectorizeQueueUrl = () => {
  const url = Resource.fabFileVectorizeQueue.url;
  if (!url) throw new Error('Vectorize queue URL not found');
  return url;
};

/**
 * Fan a file's chunks out to the vectorize queue. Only chunk IDS travel (full chunks would
 * exceed SQS's 256KB message limit). Returns the number of messages sent.
 */
async function enqueueVectorizeBatches(params: {
  fabFileId: string;
  userId: string;
  embeddingModel: string;
  chunkIds: string[];
}): Promise<number> {
  const { fabFileId, userId, embeddingModel, chunkIds } = params;
  const queueUrl = vectorizeQueueUrl();
  const batches: string[][] = [];
  for (let i = 0; i < chunkIds.length; i += VECTORIZE_BATCH_SIZE) {
    batches.push(chunkIds.slice(i, i + VECTORIZE_BATCH_SIZE));
  }
  await Promise.all(
    batches.map(ids =>
      sendToQueue(queueUrl, {
        fabFileId,
        chunkIds: ids,
        userId,
        embeddingModel,
        batchSize: ids.length,
      })
    )
  );
  return batches.length;
}

/**
 * Account a terminal failure of one step of this handler onto the file and its batch: persist a
 * per-file error and count the file as failed so the batch still reaches a terminal state.
 * Shared by the chunking and the vectorize-enqueue paths - both leave a file that is invisible
 * (no error, no alert) if nothing records the failure. No-op on a non-final SQS delivery: see
 * deferFailureIfRetryable for why an earlier attempt must leave 'failed' untouched. The caller
 * always rethrows afterwards, so SQS retries and eventually routes to the DLQ.
 */
async function accountFileFailure(params: {
  event: SQSEvent;
  logger: Logger;
  fabFileId: string;
  batchId: string | undefined;
  userId: string;
  action: string;
  errorMessage: string;
}): Promise<void> {
  const { event, logger, fabFileId, batchId, userId, action, errorMessage } = params;

  if (
    await deferFailureIfRetryable(event, FAB_FILE_CHUNK_MAX_RECEIVE_COUNT, {
      fabFileId,
      batchId,
      action,
      errorMessage,
      logger,
    })
  ) {
    return;
  }

  const isFirstFailure = await fabFileRepository.markFailedIfNotAlready(fabFileId, errorMessage);
  if (!batchId || !isFirstFailure) return;

  try {
    await dataLakeBatchRepository.updateFileStatus(batchId, fabFileId, 'failed', errorMessage);
    // One atomic $inc for both counters - two sequential incrementCounter calls could
    // leave failedFiles bumped without processingFailedFiles on a crash between them,
    // misclassifying this as an upload failure with no automatic recovery (#1412).
    const batch = await dataLakeBatchRepository.incrementCounters(batchId, {
      failedFiles: 1,
      processingFailedFiles: 1,
    });
    await finalizeBatchIfComplete(batch, logger);
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'data_lake_batch_progress',
      batchId,
      failedFiles: batch?.failedFiles ?? 1,
      processingFailedFiles: batch?.processingFailedFiles ?? 1,
      status: isBatchComplete(batch) ? (batch!.failedFiles > 0 ? 'completed_with_errors' : 'completed') : undefined,
    });
  } catch (innerErr) {
    logger.error(`Error reporting batch ${action.toLowerCase()} failure: ${innerErr}`);
  }
}

/**
 * Re-send the vectorize fan-out for the chunks of an already-chunked file that still hold no
 * vector, and clear the stranded markers when it lands. This is the recovery half of the
 * committed-chunks-but-no-vectors state: a plain SQS redelivery reaches it, and so does the
 * stranded-vectorize sweep (buildStrandedVectorizeScanFilter) by re-enqueueing a chunk message.
 * Non-destructive - it sends messages only, and the vectorize handler dedupes.
 *
 * The chunks were sized against the model they were chunked under, so that model (not the current
 * default, which may have changed since) is what their embeddings must be generated with.
 */
async function resumeVectorizeEnqueue(
  event: SQSEvent,
  logger: Logger,
  fabFile: {
    id: string;
    batchId?: string;
    embeddingModel?: string;
    error?: string | null;
    vectorizeEnqueueFailedAt?: Date | null;
  },
  userId: string,
  defaultEmbeddingModel: string
): Promise<void> {
  const fabFileId = fabFile.id;
  const pendingChunkIds = await fabFileChunkRepository.findVectorlessChunkIds(fabFileId);
  const ownsError = !!fabFile.error?.startsWith(VECTORIZE_ENQUEUE_ERROR_PREFIX);
  const wasStranded = !!fabFile.vectorizeEnqueueFailedAt || ownsError;

  if (pendingChunkIds.length === 0) {
    if (wasStranded) await clearStrandedMarkers(fabFileId, ownsError, logger);
    return;
  }

  const embeddingModel =
    fabFile.embeddingModel && isSupportedEmbeddingModel(fabFile.embeddingModel)
      ? fabFile.embeddingModel
      : defaultEmbeddingModel;

  try {
    const batchCount = await enqueueVectorizeBatches({ fabFileId, userId, embeddingModel, chunkIds: pendingChunkIds });
    logger.log(
      `Resumed vectorize fan-out for ${fabFileId}: ${pendingChunkIds.length} un-vectorized chunk(s) in ${batchCount} batch(es)`
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Re-stamp: the sweep waits out its grace period from this timestamp, which keeps a queue
    // that is down from being re-swept every cycle.
    await FabFile.updateOne({ _id: fabFileId }, { $set: { vectorizeEnqueueFailedAt: new Date() } }).catch(stampErr =>
      logger.error(`Failed to stamp vectorize-enqueue failure on ${fabFileId}: ${stampErr}`)
    );
    await accountFileFailure({
      event,
      logger,
      fabFileId,
      batchId: fabFile.batchId,
      userId,
      action: 'Vectorize enqueue',
      errorMessage: `${VECTORIZE_ENQUEUE_ERROR_PREFIX}: ${errorMessage}`,
    });
    throw err;
  }

  if (wasStranded) await clearStrandedMarkers(fabFileId, ownsError, logger);
}

/**
 * Drop the markers a failed hand-off left behind, so the file stops matching the rescue sweep and
 * stops showing an error it has recovered from. `error` is cleared ONLY when this handler wrote it
 * (see VECTORIZE_ENQUEUE_ERROR_PREFIX) - a chunking or vectorizing error from elsewhere is still
 * true and must survive.
 */
async function clearStrandedMarkers(fabFileId: string, ownsError: boolean, logger: Logger): Promise<void> {
  await FabFile.updateOne(
    { _id: fabFileId },
    { $unset: { vectorizeEnqueueFailedAt: 1 }, ...(ownsError ? { $set: { error: null } } : {}) }
  ).catch(err => logger.error(`Failed to clear vectorize-enqueue markers on ${fabFileId}: ${err}`));
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { fabFileId, userId, chunkSize } = ChunkFabFilePayload.parse(JSON.parse(body));

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

  // Idempotency: never re-chunk a file that is already chunked. chunkFabfile's own
  // deleteManyByFabFileId (called unconditionally on every run) would wipe out and replace chunks
  // a prior successful delivery already created - possibly ones already vectorized - the exact
  // destructive case the rescue sweep can trigger (a deferred, non-final attempt clears
  // isChunking/leaves error unset for the whole retry window, matching the sweep's filter; see
  // chunkScan.ts). Mirrors fabFileVectorize.ts's own early-return.
  //
  // 'Already chunked' does NOT mean 'already handed off', though: the vectorize fan-out at the
  // end of this handler runs after the chunk rows and `chunked: true` are committed, so a failed
  // (or half-finished) enqueue leaves a file with chunks and no vectors. Resume the fan-out for
  // whatever chunks still lack a vector instead of returning - that is what makes the enqueue
  // retryable, both on SQS redelivery and from the stranded-vectorize rescue sweep. The vectorize
  // handler is itself idempotent, and a file that really did finish has nothing left to send.
  if (fabFile.chunked || fabFile.notes?.startsWith(NO_EXTRACTABLE_TEXT_NOTE_PREFIX)) {
    logger.log(`FabFile ${fabFileId} already chunked, skipping re-chunk`);
    if (fabFile.chunked) {
      await resumeVectorizeEnqueue(event, logger, fabFile, userId, defaultEmbeddingModel);
    }
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
          passageTokenTarget: chunkSize,
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
          searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
        }
      )
    ).catch(async (err: unknown) => {
      // chunkFabfile can throw on a genuinely bad file (e.g. a corrupt PDF). Without the
      // accounting below, the file would sit at chunkCount:0 with no error - visually identical
      // to a silently-dropped record.
      await accountFileFailure({
        event,
        logger,
        fabFileId,
        batchId: fabFile.batchId,
        userId,
        action: 'Chunking',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });

    logger.updateMetadata({
      fabFileChunksCount: fabFileChunks.length,
    });

    // Non-fatal: this whole block runs inside a plain try/finally (no catch), so an
    // uncaught throw here would fail the entire message over a best-effort UI push and
    // force a wasted re-chunk on redelivery instead of just missing one notification.
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'update_file_chunk_vector_status',
      fabFileId,
      chunkStatus: 'complete',
      vectorizeStatus: 'ongoing',
    }).catch(err => logger.error(`Error notifying chunk-complete for ${fabFileId}: ${err}`));

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
      // The prefix doubles as the chunk-scan exclusion marker (see buildFabFileChunkScanFilter),
      // so the rescue sweep never re-enqueues a file that deterministically chunks to zero.
      await FabFile.updateOne(
        { _id: fabFileId },
        {
          $set: {
            notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX} - re-process or re-upload (e.g. image-only or unsupported content).`,
          },
        }
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

    // The chunk rows and `chunked: true` are committed by now, so a failure here is NOT just a
    // lost message: the idempotency guard above will refuse to re-chunk on redelivery, and the
    // un-chunked rescue sweep cannot see a file that has chunks (its filter is chunkCount: 0).
    // Stamp the file so the stranded-vectorize sweep can find it, record the failure so it is
    // visible instead of silent, then rethrow so SQS retries into the resume path above.
    let batchCount: number;
    try {
      batchCount = await enqueueVectorizeBatches({
        fabFileId,
        userId,
        embeddingModel: defaultEmbeddingModel,
        chunkIds: fabFileChunks.map(c => c.id),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await FabFile.updateOne({ _id: fabFileId }, { $set: { vectorizeEnqueueFailedAt: new Date() } }).catch(stampErr =>
        logger.error(`Failed to stamp vectorize-enqueue failure on ${fabFileId}: ${stampErr}`)
      );
      await accountFileFailure({
        event,
        logger,
        fabFileId,
        batchId: fabFile.batchId,
        userId,
        action: 'Vectorize enqueue',
        errorMessage: `${VECTORIZE_ENQUEUE_ERROR_PREFIX}: ${errorMessage}`,
      });
      throw err;
    }

    logger.updateMetadata({ batchCount });
    logger.log(`Sent ${batchCount} batches to vectorize queue`);
    logger.log('====================================');
    logger.log('Completed chunk queue handler');
    logger.log('====================================');
  } finally {
    await FabFile.updateOne({ _id: fabFileId }, { $set: { isChunking: false } }).catch(err =>
      logger.error(`Failed to clear isChunking for ${fabFileId}: ${err}`)
    );
  }
});
