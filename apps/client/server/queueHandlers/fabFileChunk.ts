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
import { CONVERGENCE_PAUSED_CHUNK_NOTE, DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT } from '@bike4mind/common';
import { effectiveChunkTokenLimit, FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { getFilesStorage } from '@server/utils/storage';
import { sendToQueue } from '@server/utils/sqs';
import { dispatchWithLogger, MARK_PAUSED_MAX_ATTEMPTS, MARK_PAUSED_RETRY_DELAY_MS } from '@server/queueHandlers/utils';
import {
  finalizeBatchIfComplete,
  isBatchComplete,
  deferFailureIfRetryable,
} from '@server/queueHandlers/dataLakeBatchProgress';
import { FAB_FILE_CHUNK_MAX_RECEIVE_COUNT } from '@server/queueHandlers/sqsDelivery';
import { isChunkClaimLostError, isSupportedEmbeddingModel } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { NO_EXTRACTABLE_TEXT_NOTE_PREFIX, CHUNK_CLAIM_STALE_MS } from '@server/worker/chunkScan';
import { isConvergenceHalted } from '@server/queueHandlers/convergenceKillSwitch';
import { provenancePayloadShape } from '@server/queueHandlers/convergenceProvenance';
import type { Logger } from '@bike4mind/observability';
import type { SQSEvent } from 'aws-lambda';
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

/**
 * Prefix of the error this handler stores when the vectorize hand-off fails. Load-bearing: the
 * resume path clears the file's `error` only when it owns it, so a real chunking/vectorizing
 * error from elsewhere is never wiped by a successful re-enqueue.
 */
const VECTORIZE_ENQUEUE_ERROR_PREFIX = 'Could not hand off for vector indexing';

/**
 * How many chunks per vectorize message is the operator's dataLakeVectorizeChunkBatchSize
 * lever. Unlike the spend levers, this is not a money value, so a resolution failure falls
 * back to the coded default instead of halting - chunking itself spends nothing, and the spend
 * gate in fabFileVectorize.ts is where money is actually guarded.
 */
const resolveVectorizeBatchSize = (logger: Logger): Promise<number> =>
  dataLakeService
    .resolveSpendLevers({ adminSettings: adminSettingsRepository }, logger)
    .then(levers => levers.vectorizeChunkBatchSize)
    .catch((err: unknown) => {
      logger.warn(`Could not resolve vectorize batch size; using default: ${err}`);
      return DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT;
    });

/**
 * Fan a file's chunks out to the vectorize queue. Only chunk IDS travel (full chunks would
 * exceed SQS's 256KB message limit). Returns the number of messages sent.
 */
async function enqueueVectorizeBatches(params: {
  fabFileId: string;
  userId: string;
  embeddingModel: string;
  chunkIds: string[];
  batchSize: number;
  origin?: string;
  lakeId?: string;
}): Promise<number> {
  const { fabFileId, userId, embeddingModel, chunkIds, batchSize, origin, lakeId } = params;
  const queueUrl = Resource.fabFileVectorizeQueue.url;
  if (!queueUrl) throw new Error('Vectorize queue URL not found');

  const batches: string[][] = [];
  for (let i = 0; i < chunkIds.length; i += batchSize) {
    batches.push(chunkIds.slice(i, i + batchSize));
  }
  await Promise.all(
    batches.map(ids =>
      sendToQueue(queueUrl, {
        fabFileId,
        chunkIds: ids,
        userId,
        embeddingModel,
        batchSize: ids.length,
        // Carry provenance downstream: the switch may flip while these vectorize messages sit
        // in-flight, so the vectorize handler re-checks with the same origin/lakeId (#1676).
        origin,
        lakeId,
      })
    )
  );
  return batches.length;
}

/**
 * Account a terminal failure of one step of this handler onto the file and its batch: persist a
 * per-file error and count the file as failed so the batch still reaches a terminal state.
 * Shared by the chunking and the vectorize-enqueue paths - both leave a file that is invisible
 * (no error, no alert) if nothing records the failure. Persisting `error` is also what makes the
 * file terminal for the daily un-chunked rescue sweep (see buildFabFileChunkScanFilter in
 * chunkScan.ts); a path that throws without it leaves the file permanently sweep-eligible, so it
 * is re-enqueued and re-DLQ'd every day forever. No-op on a non-final SQS delivery: see
 * deferFailureIfRetryable for why an earlier attempt must leave 'failed' untouched. The caller
 * always rethrows afterwards, so SQS retries and eventually routes to the DLQ. Mirrors
 * fabFileVectorize.ts's own failure handling - keep the two in sync.
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
 * Stamp the marker the stranded-vectorize rescue sweep selects on
 * (buildStrandedVectorizeScanFilter) and account the failure so it is visible rather than silent.
 * Re-stamped on every failed attempt: the sweep waits out its grace period from this timestamp,
 * which keeps a queue that is down from being re-swept every cycle.
 */
async function recordVectorizeEnqueueFailure(params: {
  event: SQSEvent;
  logger: Logger;
  fabFileId: string;
  batchId: string | undefined;
  userId: string;
  err: unknown;
}): Promise<void> {
  const { event, logger, fabFileId, batchId, userId, err } = params;
  await FabFile.updateOne({ _id: fabFileId }, { $set: { vectorizeEnqueueFailedAt: new Date() } }).catch(stampErr =>
    logger.error(`Failed to stamp vectorize-enqueue failure on ${fabFileId}: ${stampErr}`)
  );
  await accountFileFailure({
    event,
    logger,
    fabFileId,
    batchId,
    userId,
    action: 'Vectorize enqueue',
    errorMessage: `${VECTORIZE_ENQUEUE_ERROR_PREFIX}: ${err instanceof Error ? err.message : String(err)}`,
  });
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

/**
 * The batch-accounting half of the same undo. accountFileFailure wrote three things on the way
 * down - the FabFile error, the manifest entry ('failed' + the error text), and
 * failedFiles/processingFailedFiles - and clearStrandedMarkers above reverses only the first, so
 * a recovered file still reports as a failure on its batch. Worse, 'failed' is not in the
 * vectorize handler's success-path claim set, so the file could never reach 'complete' and its
 * vectorizedFiles was lost with it.
 *
 * `to` is where the file actually is once the strand is undone: 'complete' when its chunks
 * already hold every vector (nothing further is coming to claim the entry, so this call also owes
 * the batch the vectorizedFiles), 'chunking' when a fresh fan-out is about to go out and the
 * vectorize handler's own claim will finish the job.
 *
 * Reopen first, revert second: the counter writes are guarded on a non-terminal batch, and a
 * strand on the last outstanding file may already have finalized this batch
 * 'completed_with_errors'. In that order a crash in between leaves the batch merely non-terminal,
 * which the stuck-batch reconciler re-settles; the reverse would leave it terminal with a tally
 * that no longer adds up. Same reasoning covers the reopen that finds nothing of ours to revoke:
 * a non-terminal batch the reconciler settles again beats a wrong tally left standing.
 *
 * Best-effort, like the marker write it accompanies: a reporting correction must never fail a
 * delivery whose actual work (the file's vectors) succeeded.
 */
async function revertStrandBatchAccounting(params: {
  batchId: string;
  fabFileId: string;
  userId: string;
  to: 'complete' | 'chunking';
  logger: Logger;
}): Promise<void> {
  const { batchId, fabFileId, userId, to, logger } = params;
  try {
    await dataLakeBatchRepository.reopenFinalizedWithErrors(batchId);
    const batch = await dataLakeBatchRepository.revertFileFailure(batchId, fabFileId, to, {
      errorPrefix: VECTORIZE_ENQUEUE_ERROR_PREFIX,
      ...(to === 'complete' ? { alsoIncrement: { vectorizedFiles: 1 } } : {}),
    });
    if (!batch) return; // nothing of ours to revoke - another failure owns this entry.

    await finalizeBatchIfComplete(batch, logger);
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'data_lake_batch_progress',
      batchId,
      failedFiles: batch.failedFiles,
      processingFailedFiles: batch.processingFailedFiles,
      vectorizedFiles: batch.vectorizedFiles,
      status: isBatchComplete(batch) ? (batch.failedFiles > 0 ? 'completed_with_errors' : 'completed') : undefined,
    });
  } catch (err) {
    logger.error(`Error reverting the vectorize-enqueue failure accounting for ${fabFileId}: ${err}`);
  }
}

/**
 * Re-send the vectorize fan-out for the chunks of an already-chunked file that still hold no
 * vector, undoing everything the strand recorded first. This is the recovery half of the
 * committed-chunks-but-no-vectors state: a plain SQS redelivery reaches it, and so does the
 * stranded-vectorize sweep (buildStrandedVectorizeScanFilter) by re-enqueueing a chunk message.
 * Non-destructive - it sends messages only, and the vectorize handler dedupes.
 *
 * The chunks were sized against the model they were chunked under, so that model (not the current
 * default, which may have changed since) is what their embeddings must be generated with.
 *
 * Deliberately NOT gated on `wasStranded`: any redelivery for an already-chunked file resumes, not
 * only one carrying a marker. That is a chosen trade-off, not an accident of where `wasStranded` is
 * read. Gating would be cheaper - an ordinary at-least-once duplicate arriving while the first
 * fan-out is still in flight re-embeds the chunks that have not landed a vector yet, and the
 * vectorize handler's idempotency guard is file-level, so a PARTIALLY vectorized file does not
 * short-circuit it: that is metered spend, not just wasted work. It loses to the other side. Both
 * marker writes are best-effort (see recordVectorizeEnqueueFailure and clearStrandedMarkers), so a
 * file whose stamp AND error write both failed carries no marker at all, is invisible to the rescue
 * sweep, and an ungated resume is the only thing that still recovers it - which is exactly the
 * permanently-unreachable state this whole path exists to eliminate. Bounded duplicate spend on a
 * healthy file is the cheaper failure.
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
  defaultEmbeddingModel: string,
  provenance: { origin?: string; lakeId?: string }
): Promise<void> {
  const fabFileId = fabFile.id;
  const pendingChunkIds = await fabFileChunkRepository.findVectorlessChunkIds(fabFileId);
  const ownsError = !!fabFile.error?.startsWith(VECTORIZE_ENQUEUE_ERROR_PREFIX);
  const wasStranded = !!fabFile.vectorizeEnqueueFailedAt || ownsError;

  if (pendingChunkIds.length === 0) {
    if (wasStranded) {
      await clearStrandedMarkers(fabFileId, ownsError, logger);
      if (fabFile.batchId) {
        await revertStrandBatchAccounting({ batchId: fabFile.batchId, fabFileId, userId, to: 'complete', logger });
      }
    }
    return;
  }

  const embeddingModel =
    fabFile.embeddingModel && isSupportedEmbeddingModel(fabFile.embeddingModel)
      ? fabFile.embeddingModel
      : defaultEmbeddingModel;

  // Undo the strand BEFORE the fan-out, not after. The vectorize handler claims its manifest entry
  // from ['chunking','uploaded','pending'], so a message that lands while the entry still reads
  // 'failed' loses that claim and the file is never counted complete - and these messages can be
  // picked up within milliseconds of the send. Clearing the FabFile markers in the same breath
  // keeps the two surfaces in step: if the fan-out then fails again, markFailedIfNotAlready sees
  // an unfailed file and re-records the failure on BOTH the file and the batch, where a
  // half-undone state would have left the batch permanently short a failure it still has.
  //
  // The window this opens - markers cleared, hand-off not yet re-recorded - is closed by the
  // message itself: this path only ever runs on a delivery that is about to either succeed or
  // throw and be redelivered, and the resume is ungated on `wasStranded` precisely so a
  // marker-less file still recovers (see this function's doc comment).
  if (wasStranded) {
    await clearStrandedMarkers(fabFileId, ownsError, logger);
    if (fabFile.batchId) {
      await revertStrandBatchAccounting({ batchId: fabFile.batchId, fabFileId, userId, to: 'chunking', logger });
    }
  }

  try {
    const batchCount = await enqueueVectorizeBatches({
      fabFileId,
      userId,
      embeddingModel,
      chunkIds: pendingChunkIds,
      batchSize: await resolveVectorizeBatchSize(logger),
      ...provenance,
    });
    logger.log(
      `Resumed vectorize fan-out for ${fabFileId}: ${pendingChunkIds.length} un-vectorized chunk(s) in ${batchCount} batch(es)`
    );
  } catch (err) {
    await recordVectorizeEnqueueFailure({ event, logger, fabFileId, batchId: fabFile.batchId, userId, err });
    throw err;
  }
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { fabFileId, userId, chunkSize, origin, lakeId } = ChunkFabFilePayload.parse(JSON.parse(body));

  logger.updateMetadata({ fabFileId, userId });

  // Convergence kill switch (#1676): re-check inside the SHARED handler so a paused switch stops
  // background work already on the queue. Gated before any DB read, so a user upload (origin absent)
  // short-circuits with zero I/O.
  //
  // Dropping the message is NOT the whole job. By the time this runs, the producer has already reset
  // the wave's chunk state, so the file sits at chunkCount 0 with no error. The reset stamps
  // `chunkRebuildRequestedAt` (#1939), so that state is not invisible - but it reads as "rebuilding,
  // returns on its own", which is now false: nothing will rebuild this file until an administrator
  // lifts the switch. So upgrade the stamp to `CONVERGENCE_PAUSED_CHUNK_NOTE`, the marker every
  // reader keys on to say "halted, needs intervention". Mirrors what the vectorize handler already
  // does for its half of the same switch.
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
    // Retried in-process, then FAILED to SQS rather than acked. Losing this write loses the
    // distinction between "halted, needs an administrator" and "rebuilding, returns on its own" -
    // and it is the second that every reader would go on believing, indefinitely. Kept a hard
    // failure rather than a best-effort ack now that the state is visible either way: the in-process
    // attempts handle the realistic case (a pool timeout, a stepdown, a blip), the throw handles the
    // rest, and a redelivery is the only thing that can still repair the label.
    //
    // Throwing is safe and bounded, which is why it beats acking here:
    //  - Nothing destructive has run in this branch, so a redelivery is idempotent - it re-reads the
    //    switch and either marks again or, if the switch has since gone OFF, rebuilds the file for
    //    real, which is a better outcome than any marker.
    //  - It cannot spin: fabFileChunkQueue sets `dlq: { retry: 3 }` (infra/queues.ts), so this is at
    //    most three receives before the message lands in fabFileChunkQueueDLQ - which is already in
    //    DLQ_DESCRIPTORS and dlqRegistry, so it alarms and is replayable from admin. A permanently
    //    mislabelled file becomes a bounded retry and then a visible operational signal.
    //
    // Note the 60-minute visibility timeout on that queue: a redelivery is an hour away, so this
    // guarantees eventual correctness, NOT a short window. The window itself is closed by
    // `chunkRebuildRequestedAt` (#1939), which `resetChunkStateByIds` stamps atomically with the
    // reset - so this write is an UPGRADE of a state that is already visible, not the one thing
    // standing between the file and invisibility. That is why losing it is now survivable: the file
    // keeps reading as "rebuild in flight" (mislabelled, since nothing is going to rebuild it until
    // the switch comes off) rather than as an image.
    //
    // The stamp is cleared in the SAME `$set` as the note, so the two states can never both be
    // present: this file is paused, not pending. Clearing it here rather than leaving it also stops
    // the "Rebuild passages" door's stale-pending arm from double-counting a file its paused arm
    // already selects.
    for (let attempt = 1; attempt <= MARK_PAUSED_MAX_ATTEMPTS; attempt++) {
      try {
        await fabFileRepository.update({
          id: fabFileId,
          notes: CONVERGENCE_PAUSED_CHUNK_NOTE,
          chunkRebuildRequestedAt: null,
        });
        break;
      } catch (err) {
        if (attempt === MARK_PAUSED_MAX_ATTEMPTS) {
          logger.error(
            `[convergenceKillSwitch] could not mark ${fabFileId} as paused mid-rechunk after ` +
              `${MARK_PAUSED_MAX_ATTEMPTS} attempts; failing the delivery so SQS retries rather than ` +
              `leaving it reported as a rebuild that will finish on its own: ${err}`
          );
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, MARK_PAUSED_RETRY_DELAY_MS * attempt));
      }
    }
    logger.log(
      `[convergenceKillSwitch] Paused background chunk work for fabFileId ${fabFileId}` +
        (lakeId ? ` (lake ${lakeId})` : '') +
        ' - kill switch on; message dropped and the file marked as having no passages. Convergence' +
        ' re-selects it (and health reports it) until it is rebuilt.'
    );
    return;
  }

  // Single-run lease: the only PRODUCER-side-independent exclusion in the chunk path. chunkFabfile
  // unconditionally deletes then recreates a file's chunks, so at most one worker may run it per file.
  //
  // This compare-and-set is deliberately the whole producer-facing mechanism: producers (a "Rebuild
  // passages" wave, the rescue sweep, an upload, a per-file reprocess) just reset and enqueue, and two
  // deliveries for one file are resolved HERE regardless of who sent them. Splitting exclusion across
  // a producer pre-claim and a consumer token is what broke this path repeatedly - the producer marks
  // a file busy, and the consumer then cannot tell its own reservation from someone else's run.
  //
  // chunkFabfile (#1802) never writes isChunking or chunkClaimedAt itself - the claim is held for
  // the ENTIRE run and released only by this handler's own `finally` below. A second, independent
  // guard lives inside chunkFabfile itself: immediately before any write, it re-confirms this run's
  // chunkClaimedAt stamp still matches (a guarded write, not a read - see chunk.ts), which is what
  // catches a run that outlived the 30-minute stale window and was already taken over by a
  // successor.
  //
  // The three arms are: free (not being chunked), or a claim stale past CHUNK_CLAIM_STALE_MS (a
  // worker hard-killed before its finally), or the null-stamp backfill arm for files stuck
  // isChunking:true from before chunkClaimedAt existed. They mirror buildFabFileChunkScanFilter, so
  // the sweep and the worker agree on what "in flight" means. Acquired FIRST, before any pre-flight
  // check, so every throw/return below still runs the `finally` that releases it.
  //
  // Concurrent duplicate: loser matches no arm (isChunking true, stamp fresh) and returns.
  // SQS retry: attempt 1's `finally` cleared isChunking, so arm 1 matches and the ladder survives.
  // Redundant enqueue after a successful run: the `chunked` guard below skips it.
  let acquired = false;
  // Hoisted so the release below can compare-and-set on the stamp this run actually claimed with.
  let claimedAt: Date | undefined;
  try {
    const now = new Date();
    const staleClaimBefore = new Date(now.getTime() - CHUNK_CLAIM_STALE_MS);
    const claimDoc = await FabFile.findOneAndUpdate(
      {
        _id: fabFileId,
        $or: [
          { isChunking: { $ne: true } },
          { isChunking: true, chunkClaimedAt: { $lt: staleClaimBefore } },
          { isChunking: true, chunkClaimedAt: null },
        ],
      },
      { $set: { isChunking: true, chunkClaimedAt: now } }
    );
    if (!claimDoc) {
      logger.log(`FabFile ${fabFileId}: already being chunked by another delivery, skipping`);
      return;
    }
    acquired = true;
    claimedAt = now;

    logger.log('====================================');
    logger.log(`Started chunk queue handler for fabFileId: ${fabFileId}`);
    logger.log('====================================');

    // Pre-flight runs inside its own accounting catch: these throws are permanent for this file
    // (a deleted user can never come back), and without accounting they leave `error` unset, which
    // keeps the file eligible for the daily rescue sweep forever - one orphan then re-DLQs daily.
    // The batch id comes from the claim document, which is this file's FabFile, so a pre-flight
    // failure is still accounted into its batch without a second read.
    const { user, defaultEmbeddingModel, fabFile } = await (async () => {
      const user = await User.findById(userId);
      if (!user) throw new Error(`User not found for userId: ${userId}`);

      const defaultEmbeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
      if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) {
        throw new BadRequestError('Default embedding model not found');
      }

      const fabFile = await fabFileRepository.shareable.findAccessibleById(user, fabFileId);
      return { user, defaultEmbeddingModel, fabFile };
    })().catch(async (err: unknown) => {
      await accountFileFailure({
        event,
        logger,
        fabFileId,
        batchId: claimDoc.batchId?.toString(),
        userId,
        action: 'Chunking',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });

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
    // Runs under this run's claim, so two deliveries cannot resume the same file at once.
    if (fabFile.chunked || fabFile.notes?.startsWith(NO_EXTRACTABLE_TEXT_NOTE_PREFIX)) {
      logger.log(`FabFile ${fabFileId} already chunked, skipping re-chunk`);
      if (fabFile.chunked) {
        await resumeVectorizeEnqueue(event, logger, fabFile, userId, defaultEmbeddingModel, { origin, lakeId });
      }
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

    // Tag data-lake chunk logs with the batch id for incident triage (the lake is derivable
    // from the batch). dataLakeId isn't on the FabFile and isn't worth an extra read here.
    if (fabFile.batchId) logger.updateMetadata({ batchId: fabFile.batchId });

    const chunkAdapters = {
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
    };

    // Two phases, and only the second one is transactional (#1681 constraint 3). The S3 fetch and
    // full tokenization used to run INSIDE `withTransaction`, which put them under the transaction
    // lifetime: a member too large to finish aborts with a code `withTransaction` classifies as
    // transient, so it redid the fetch and the tokenization up to `maxRetries` more times before
    // failing deterministically. Convergence sweeps the LARGEST documents first, which is exactly
    // that population. Now a transient write conflict retries the writes alone.
    const fabFileChunks = await (async () => {
      const prepared = await fabFilesService.prepareFabFileChunks(
        user,
        {
          fabFileId,
          embeddingModel: defaultEmbeddingModel,
          passageTokenTarget: requestedPassageTokenTarget,
          chunkClaimedAt: claimedAt,
        },
        chunkAdapters
      );
      return withTransaction(async () => fabFilesService.commitFabFileChunks(prepared, chunkAdapters));
    })().catch(async (err: unknown) => {
      // A stale-claim takeover already reassigned this file to a successor mid-run (#1802 Phase
      // 2) - not a failure, so this delivery must NOT count toward batch failure accounting or
      // reach the DLQ. Returning null (rather than throwing) lets SQS delete the message as
      // successfully processed; the successor is the one actually finishing this file.
      if (isChunkClaimLostError(err)) {
        // WARN, not log/info: this is a RETURN/swallow path (see queueHandlers/utils.ts's own
        // documented contract), and a benign no-op is still the event an operator triaging a stuck
        // file wants visible above INFO noise.
        // Wording deliberately names both possible causes rather than asserting one (#1802
        // follow-up): a hard-deleted FabFile and a genuinely-superseded claim both fail the guard
        // identically, and a DB read to tell them apart was tried and dropped - it ran inside a
        // catch whose whole contract is "must never fail this delivery," and a soft-deleted file
        // (the common case) would have been mislabeled as hard-deleted regardless.
        logger.warn(
          `FabFile ${fabFileId}: chunk claim lost (a successor claimed it, or the file was removed) - this delivery is a no-op`
        );
        return null;
      }

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

    // The claim was lost to a successor mid-run (see the catch above) - that successor owns
    // finishing this file (notifications, batch progress, vectorize dispatch), so this delivery
    // stops here rather than acting on a stale/absent chunk result.
    if (fabFileChunks === null) {
      return;
    }

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
    // THIS path never re-chunks to satisfy one lake (which would rewrite shared chunks for
    // non-members and oscillate a file in two disagreeing lakes).
    //
    // Owner-triggered convergence (#1681) is the one door that does re-chunk at a lake's required
    // target, and it is allowed to only because it first proves the disagreement does not exist:
    // it refuses any member whose OTHER member lakes declare a different effective target. Nothing
    // here changes - it still just records what the chunks were built with, and the target it
    // records is the one the convergence message asked for, so the conflict clears on that pass.
    //
    // Best-effort: a detection failure must not fail an otherwise-successful chunk and force a
    // wasted re-chunk on redelivery.
    try {
      const conflict = await dataLakeService.recomputeFileChunkPolicyConflict(
        { id: fabFileId, userId: fabFile.userId, tags: fabFile.tags },
        effectivePassageTokenTarget,
        {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
          embeddingModel: defaultEmbeddingModel,
          logger,
        }
      );

      // Lake admission decision (#1679), report-only and permanently so: a member whose chunks
      // cannot honor a lake it belongs to is quarantined - admitted content that will never be
      // retrievable. Blocking HERE would be eviction, not admission: the file is already a member
      // by the time it chunks. The hard gate (#1680) reads this same signal at the membership
      // write instead - see dataLakeService/lakeAdmissionGate.ts - so a file that reaches this
      // point under an enforcing lake is one that was admitted before the lever was turned on, or
      // whose owner chunk policy changed afterwards. Both are convergence cases (#1681), not
      // admission ones. Log the verdict with the DOOR the member came through, which the policy
      // recompute cannot see, so a smoke test can tell a quarantined member from an unchecked one.
      const admissionStatus = dataLakeService.deriveAdmissionStatus(conflict);
      if (conflict) {
        logger.warn(
          `[admission] file ${fabFileId} ${admissionStatus} (report-only) via ${dataLakeService.admissionDoorLabel(fabFile.sourceType)}: ` +
            `chunks at target ${effectivePassageTokenTarget} cannot honor ${conflict.lakes.length} lake policy(ies)`
        );
      }
    } catch (err) {
      logger.error(`Error computing chunk-policy conflict for ${fabFileId}: ${err}`);
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
        batchSize: await resolveVectorizeBatchSize(logger),
        origin,
        lakeId,
      });
    } catch (err) {
      await recordVectorizeEnqueueFailure({
        event,
        logger,
        fabFileId,
        batchId: fabFile.batchId,
        userId,
        err,
      });
      throw err;
    }

    logger.updateMetadata({ batchCount });
    logger.log(`Sent ${batchCount} batches to vectorize queue`);
    logger.log('====================================');
    logger.log('Completed chunk queue handler');
    logger.log('====================================');
  } finally {
    // Release ONLY the claim this run actually holds, matched on the stamp it claimed with. A
    // superseded/duplicate delivery (acquired=false) must not clear isChunking at all, and a run
    // whose claim was since SUPERSEDED - by the stale arm, or by a re-claim - must not clear its
    // successor's flag either: an unconditional clear turns one takeover into a cascade, re-opening
    // arm 1 for a third worker while the second is still running.
    if (acquired && claimedAt) {
      await FabFile.updateOne({ _id: fabFileId, chunkClaimedAt: claimedAt }, { $set: { isChunking: false } }).catch(
        err => logger.error(`Failed to clear isChunking for ${fabFileId}: ${err}`)
      );
    }
  }
});
