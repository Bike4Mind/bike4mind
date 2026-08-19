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
import { dispatchWithLogger } from '@server/queueHandlers/utils';
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

/** Attempts at the paused marker before giving up; see the write's own note for why it retries. */
const MARK_PAUSED_MAX_ATTEMPTS = 3;
/** Linear backoff base, in ms. Small: the handler is otherwise doing nothing and holds no lease. */
const MARK_PAUSED_RETRY_DELAY_MS = 150;

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const { fabFileId, userId, chunkSize, origin, lakeId } = ChunkFabFilePayload.parse(JSON.parse(body));

  logger.updateMetadata({ fabFileId, userId });

  // Convergence kill switch (#1676): re-check inside the SHARED handler so a paused switch stops
  // background work already on the queue. Gated before any DB read, so a user upload (origin absent)
  // short-circuits with zero I/O.
  //
  // Dropping the message is NOT the whole job. By the time this runs, the producer has already reset
  // the wave's chunk state, so the file sits at chunkCount 0 with no error - and that shape is
  // indistinguishable from an image or a pending upload, which is how it fell out of health's
  // denominator, out of the convergence plan, out of the retrieval withhold and past the rescue
  // sweep's own filter, all at once. So mark it before returning: `CONVERGENCE_PAUSED_CHUNK_NOTE` is
  // what every one of those readers keys on to tell "its passages were deleted" from "it never had
  // any". Mirrors what the vectorize handler already does for its half of the same switch.
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
    // Retried in-process, then best-effort. Failing the DELIVERY is still not an option - the switch
    // is still on, so SQS would redeliver into this same branch until the message expired - but the
    // realistic failure here is a transient one (a pool timeout, a stepdown, a blip), and one attempt
    // gave it a single chance. Losing the write loses the ONE signal that tells "its passages were
    // deleted" from "it never had any", and the message is gone, so nothing retries it later.
    // Bounded and short on purpose: this runs inside a Lambda invocation that has already decided to
    // do no work, and the ERROR log remains the trail if every attempt fails.
    for (let attempt = 1; attempt <= MARK_PAUSED_MAX_ATTEMPTS; attempt++) {
      try {
        await fabFileRepository.update({ id: fabFileId, notes: CONVERGENCE_PAUSED_CHUNK_NOTE });
        break;
      } catch (err) {
        if (attempt === MARK_PAUSED_MAX_ATTEMPTS) {
          logger.error(
            `[convergenceKillSwitch] could not mark ${fabFileId} as paused mid-rechunk after ` +
              `${MARK_PAUSED_MAX_ATTEMPTS} attempts: ${err}`
          );
          break;
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

      // Lake admission decision (#1679), report-only: a member whose chunks cannot honor a lake it
      // belongs to is quarantined - admitted content that will never be retrievable. We record the
      // conflict (above) but do not yet block it; the hard gate is #1680, which reads the same
      // signal. Log the verdict with the DOOR the member came through, which the policy recompute
      // cannot see - so a smoke test can tell a quarantined member from one that was never checked.
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
