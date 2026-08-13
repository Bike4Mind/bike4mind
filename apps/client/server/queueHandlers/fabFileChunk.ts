import {
  adminSettingsRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  scopedSettingsRepository,
  FabFile,
  User,
  withTransaction,
} from '@bike4mind/database';
import { sendToClient } from '@server/websocket/utils';
import { z } from 'zod';
import { dataLakeService, fabFilesService, scopedSettingsService } from '@bike4mind/services';
import { DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT } from '@bike4mind/common';
import { effectiveChunkTokenLimit, FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
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
import { isConvergenceHalted } from '@server/queueHandlers/convergenceKillSwitch';
import { provenancePayloadShape } from '@server/queueHandlers/convergenceProvenance';
import { Resource } from 'sst';

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
  // Provenance for the convergence kill switch (#1676): distinguishes background lake work
  // (haltable) from real-time user uploads (never halted). Absent => user work.
  ...provenancePayloadShape,
});

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { fabFileId, userId, chunkSize, origin, lakeId } = ChunkFabFilePayload.parse(JSON.parse(body));

  logger.updateMetadata({ fabFileId, userId });

  // Convergence kill switch (#1676): re-check inside the SHARED handler so a paused switch stops
  // background work already on the queue. Gated before any DB read, so a user upload (origin absent)
  // short-circuits with zero I/O. Returning drops the message; the file stays un-chunked (chunkCount
  // 0), so the rescue sweep re-selects it once convergence resumes - never a lost user upload.
  if (
    await isConvergenceHalted(
      { origin, lakeId },
      {
        adminSettings: adminSettingsRepository,
        scopedSettings: scopedSettingsRepository,
        dataLakes: dataLakeRepository,
      },
      logger
    )
  ) {
    logger.log(
      `[convergenceKillSwitch] Paused background chunk work for fabFileId ${fabFileId}` +
        (lakeId ? ` (lake ${lakeId})` : '') +
        ' - kill switch on; message dropped, will re-run when convergence resumes'
    );
    return;
  }

  const user = await User.findById(userId);
  if (!user) throw new Error(`User not found for userId: ${userId}`);

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

  // Idempotency: skip a duplicate delivery once the file is already chunked. Without this,
  // chunkFabfile's own deleteManyByFabFileId (called unconditionally on every run) would wipe out
  // and replace chunks a prior successful delivery already created - possibly ones already
  // vectorized - the exact destructive case the rescue sweep can trigger (a deferred, non-final
  // attempt clears isChunking/leaves error unset for the whole retry window, matching the sweep's
  // filter; see chunkScan.ts). Mirrors fabFileVectorize.ts's own early-return.
  if (fabFile.chunked || fabFile.notes?.startsWith(NO_EXTRACTABLE_TEXT_NOTE_PREFIX)) {
    logger.log(`FabFile ${fabFileId} already chunked, skipping duplicate message`);
    return;
  }

  // Chunk policy at file-owner altitude (#1662). Resolve the owner's DefaultChunkSize (falling
  // through to the platform default) UNLESS this delivery carried an explicit chunkSize override -
  // only the UI reprocess door (/api/files/chunk) sends one; every automatic door omits it and now
  // inherits the owner-altitude policy. The resolver never throws (degrades to the platform value).
  // The chunker re-derives the same effective limit internally; we compute it here via the shared
  // helper for the cross-lake conflict check below and to log when a lever exceeds the model window.
  const ownerScope = scopedSettingsService.scopeForFileOwner({ userId: fabFile.userId });
  const resolvedChunkPolicy = await scopedSettingsService.resolveScopedSetting(
    'DefaultChunkSize',
    ownerScope,
    { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
    { logger }
  );
  const requestedPassageTokenTarget = chunkSize ?? resolvedChunkPolicy.value;
  const effectivePassageTokenTarget = effectiveChunkTokenLimit({
    model: defaultEmbeddingModel,
    passageTokenTarget: requestedPassageTokenTarget,
  });
  logger.log(
    `Chunk policy for ${fabFileId}: requested=${requestedPassageTokenTarget} ` +
      `(source=${chunkSize !== undefined ? 'payload' : resolvedChunkPolicy.source}) ` +
      `effective=${effectivePassageTokenTarget} model=${defaultEmbeddingModel}`
  );
  if (effectivePassageTokenTarget !== requestedPassageTokenTarget) {
    logger.warn(
      `Chunk policy ${requestedPassageTokenTarget} for ${fabFileId} exceeds the ${defaultEmbeddingModel} ` +
        `embedding window; reduced to ${effectivePassageTokenTarget}.`
    );
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
          passageTokenTarget: requestedPassageTokenTarget,
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
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Only account a failure into the batch/file state on the LAST SQS delivery attempt -
      // see deferFailureIfRetryable's doc comment for why an earlier attempt must leave
      // 'failed' status untouched.
      if (
        await deferFailureIfRetryable(event, FAB_FILE_CHUNK_MAX_RECEIVE_COUNT, {
          fabFileId,
          batchId: fabFile.batchId,
          action: 'Chunking',
          errorMessage,
          logger,
        })
      ) {
        throw err;
      }

      // chunkFabfile can throw on a genuinely bad file (e.g. a corrupt PDF). Without this,
      // the file would sit at chunkCount:0 with no error - visually identical to a
      // silently-dropped record. Persist a per-file error and account it as failed in its
      // batch (so the batch still reaches a terminal state), mirroring fabFileVectorize's
      // failure handling, then re-throw so SQS retries then routes to the DLQ.
      const isFirstFailure = await fabFileRepository.markFailedIfNotAlready(fabFileId, errorMessage);
      if (fabFile.batchId && isFirstFailure) {
        try {
          await dataLakeBatchRepository.updateFileStatus(fabFile.batchId, fabFileId, 'failed', errorMessage);
          // One atomic $inc for both counters - two sequential incrementCounter calls could
          // leave failedFiles bumped without processingFailedFiles on a crash between them,
          // misclassifying this as an upload failure with no automatic recovery (#1412).
          const batch = await dataLakeBatchRepository.incrementCounters(fabFile.batchId, {
            failedFiles: 1,
            processingFailedFiles: 1,
          });
          await finalizeBatchIfComplete(batch, logger);
          await sendToClient(userId, Resource.websocket.managementEndpoint, {
            action: 'data_lake_batch_progress',
            batchId: fabFile.batchId,
            failedFiles: batch?.failedFiles ?? 1,
            processingFailedFiles: batch?.processingFailedFiles ?? 1,
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

    // Cross-lake chunk-policy conflict (#1662): record the effective target these chunks were built
    // with and report any member lake whose REQUIRED policy they do not satisfy. A report, not a
    // failure - the file stays chunked at its owner-altitude policy; a lake is only a constraint, so
    // we never re-chunk to satisfy one lake (which would rewrite shared chunks for non-members and
    // oscillate a file in two disagreeing lakes). Best-effort: a detection failure must not fail an
    // otherwise-successful chunk and force a wasted re-chunk on redelivery.
    try {
      await dataLakeService.recomputeFileChunkPolicyConflict(
        { id: fabFileId, userId: fabFile.userId, tags: fabFile.tags },
        effectivePassageTokenTarget,
        {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
          embeddingModel: defaultEmbeddingModel,
          logger,
        }
      );
    } catch (err) {
      logger.error(`Error computing chunk-policy conflict for ${fabFileId}: ${err}`);
    }

    const queueUrl = Resource.fabFileVectorizeQueue.url;
    if (!queueUrl) throw new Error('Vectorize queue URL not found');

    // How many chunks per vectorize message is the operator's dataLakeVectorizeChunkBatchSize
    // lever. Unlike the spend levers, this is not a money value, so a resolution failure
    // falls back to the coded default instead of halting - chunking itself spends nothing,
    // and the spend gate in fabFileVectorize.ts is where money is actually guarded.
    const batchSize = await dataLakeService
      .resolveSpendLevers({ adminSettings: adminSettingsRepository }, logger)
      .then(levers => levers.vectorizeChunkBatchSize)
      .catch((err: unknown) => {
        logger.warn(`Could not resolve vectorize batch size; using default: ${err}`);
        return DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT;
      });
    const batches: (typeof fabFileChunks)[] = [];

    for (let i = 0; i < fabFileChunks.length; i += batchSize) {
      batches.push(fabFileChunks.slice(i, i + batchSize));
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
          // Carry provenance downstream: the switch may flip while these vectorize messages sit
          // in-flight, so the vectorize handler re-checks with the same origin/lakeId (#1676).
          origin,
          lakeId,
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
