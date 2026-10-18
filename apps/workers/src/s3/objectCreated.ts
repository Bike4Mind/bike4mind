import { adminSettingsRepository, dataLakeBatchRepository, FabFile, User, withTransaction } from '@bike4mind/database';
import { isMediaOnlyMimeType, isStorageCharged } from '@bike4mind/common';
import { decodeS3Key, findWithRetry, withContext } from '@server/s3/utils';
import { isUntrackedFabFileKey } from '@server/s3/untrackedFabFileKey';
import {
  claimModerationScan,
  scanUploadedObject,
  toVerdictPatch,
  writeModerationVerdict,
  type ModerationVerdictPatch,
} from '@server/s3/moderationScan';
import { chargeUploadedObject } from '@server/s3/storageCharge';
import { recomputeStatsForUploadedFile } from '@server/dataLakes/recomputeStatsForUploadedFile';
import { completedBatchStatus, finalizeBatchIfComplete } from '@server/dataLakes/dataLakeBatchProgress';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';

export const func = withContext(async (event, context, logger) => {
  const wsEndpoint = Resource.websocket.managementEndpoint;

  for (const record of event.Records) {
    const { object } = record.s3;
    const objectKey = decodeS3Key(object.key);
    const uploadedAt = record.eventTime ? new Date(record.eventTime) : new Date();

    logger.updateMetadata({ objectKey });

    if (isUntrackedFabFileKey(objectKey)) {
      logger.info(`Skipping S3 event for untracked file: ${objectKey}`);
      continue;
    }

    // Search for related metadata with retry/backoff to handle race conditions
    // where the S3 event fires before the metadata write is replicated.
    // 4 retries with 500ms initial delay (~7.5s total backoff) fits within
    // the Lambda's default timeout while maximising lookup attempts.
    const metadata = await findWithRetry(() => FabFile.findOne({ filePath: objectKey }), 4, 500);
    if (!metadata) {
      logger.warn(`Metadata not found for file: ${objectKey}`);
      continue;
    }

    logger.updateMetadata({ fabFileId: metadata.id, ownerId: metadata.userId });

    // `status` tracks the UPLOAD, and the bytes are in S3 by the time this event fires, so
    // record it here rather than at the end of the transaction below. Everything after this
    // point can bail out (a missing owner returns null out of the transaction) or throw with
    // every Lambda attempt exhausted, and either would otherwise strand the record on
    // 'pending' - permanently invisible to content-hash dedup, which excludes 'pending' as a
    // never-landed upload (FabFileModel.findByContentHashes).
    // Serving stays gated by moderationStatus, which this does not touch.
    // The storage charge below is judged by the status from before this flip (claimStorageCharge).
    const statusBeforeUpload = metadata.status;
    // Except where the flip alone changes how the charge rule reads the row (a pre-cutoff unstamped
    // row): there it rides the transaction's save, because a retry after a failed transaction would
    // read a persisted flip as the pre-upload status and undercharge. Such a row keeps its old status
    // while the transaction is in flight, and keeps it for good only if every attempt fails.
    const chargeFields = { storageChargedAt: metadata.storageChargedAt, createdAt: metadata.createdAt };
    const deferStatusFlip =
      metadata.status !== 'complete' &&
      isStorageCharged({ ...chargeFields, status: 'complete' }) !==
        isStorageCharged({ ...chargeFields, status: metadata.status });
    const markComplete = () =>
      FabFile.updateOne({ _id: metadata._id, status: { $ne: 'complete' } }, { $set: { status: 'complete' } });
    if (metadata.status !== 'complete') {
      if (!deferStatusFlip) await markComplete();
      metadata.status = 'complete';
    }

    // Atomically claim the right to scan this file BEFORE the transaction
    // below touches it. `metadata` above was read outside a transaction with retry/backoff
    // - two concurrent invocations (a slow in-flight scan racing an S3 at-least-once
    // redelivery) could otherwise both observe the same stale 'pending' snapshot and both
    // proceed to scan and write a verdict, with the LAST writer winning. If a redelivery's
    // scan finishes after a legitimate 'blocked' verdict was already written, that last
    // write silently un-quarantines a confirmed-explicit file. `findOneAndUpdate` is a
    // single indivisible compare-and-swap: only ONE concurrent caller can transition
    // 'pending'/unset -> 'scanning'. A caller that loses the race (scanClaimed === null)
    // must not scan - whichever invocation won the claim owns the verdict for this file.
    //
    // moderationClaimedAt is stamped into the claim so the moderation rescue sweep can reclaim a crashed 'scanning' row by
    // CLAIM age. Without it this door - the ordinary hosted-upload path, by far the highest-volume
    // one - rides the sweep's legacy `updatedAt` fallback, which any unrelated write to the row
    // resets; moderationClaimedAt exists to replace exactly that. It is also this invocation's claim
    // identity, matched by writeVerdict below.
    const claimedAt = new Date();
    const scanClaimed = await claimModerationScan(metadata._id, claimedAt);

    // Captured inside the transaction below; used for the ws emit afterward.
    // (`metadata.moderationStatus` itself is typed optional - pre-existing documents predate
    // the field - so the emit reads this guaranteed-defined local instead.) Stays 'pending'
    // for a losing-claim invocation that finds the file still mid-scan elsewhere: from the
    // client's perspective both 'pending' and 'scanning' mean "not yet servable, keep
    // waiting" - the eventual clean/blocked verdict is reported by whichever invocation
    // actually owns the scan.
    let moderationStatus: 'pending' | 'clean' | 'blocked' = 'pending';

    // The verdict this invocation scanned, once it has one. Written by writeVerdict rather than
    // through `metadata.save()` below, and doubles as the withTransaction retry guard.
    let verdictPatch: ModerationVerdictPatch | null = null;

    // Terminal verdict write, guarded on THIS invocation's claim stamp (see writeModerationVerdict):
    // a superseded claim must not overwrite a successor's verdict.
    const writeVerdict = async (
      patch: ModerationVerdictPatch,
      session: Parameters<Parameters<typeof withTransaction>[0]>[0]
    ): Promise<boolean> => {
      const landed = await writeModerationVerdict(metadata._id, claimedAt, patch, session);
      if (!landed) {
        logger.warn(
          `[Q2b] moderation claim for ${objectKey} was superseded mid-scan; discarding this invocation's verdict`
        );
      }
      return landed;
    };

    const user = await withTransaction(async session => {
      const user = await User.findById(metadata.userId).session(session);
      if (!user) {
        logger.warn(`Associated user ${metadata.userId} for newly uploaded file ${objectKey} not found`);
        return null;
      }

      // Scan uploaded images before serving them. Uploads are presigned
      // direct-to-S3 - the server never sees the bytes until this event fires or the caller asks for
      // an on-demand scan (pages/api/files/[id]/moderate.ts); whichever wins claimModerationScan scans.
      //
      // S3 ObjectCreated is at-least-once delivery - a redelivered event must
      // NOT re-scan and potentially overwrite an already-terminal verdict (Rekognition
      // confidence jitter right at the threshold could flip a previously 'blocked' file to
      // 'clean' on redelivery, a silent un-quarantine).
      if (verdictPatch) {
        // Retry guard: withTransaction retries this callback on a transient transaction error. If we
        // already completed a scan in a prior attempt of THIS invocation, re-apply that verdict (the
        // rolled-back attempt's write is gone) instead of re-invoking Rekognition a second time.
        if (!(await writeVerdict(verdictPatch, session))) moderationStatus = 'pending';
      } else if (!scanClaimed) {
        // Another invocation already owns this file's scan (or already finalized it) -
        // read a FRESH copy inside the transaction (not the stale pre-claim `metadata`) so
        // a pure redelivery onto an already-terminal file reports the real verdict, while a
        // redelivery racing an in-flight scan reports 'pending' rather than a fabricated
        // 'scanning' value the client's status union isn't equipped to handle. Do NOT
        // assign onto `metadata.moderationStatus` here - that would make the `.save()`
        // below serialize this invocation's untouched (possibly stale) copy and clobber
        // whatever the winning invocation is concurrently writing.
        const current = await FabFile.findById(metadata._id).session(session);
        if (current?.moderationStatus === 'clean' || current?.moderationStatus === 'blocked') {
          moderationStatus = current.moderationStatus;
        }
        // The winner may have persisted a byte-sniffed type; carry it so the lake stats and the
        // media-only check below do not run on the stale client-declared one. If the winner has claimed
        // but not yet written its sniffed type, this still reads the declared one.
        if (current?.mimeType) metadata.mimeType = current.mimeType;
        logger.info(
          `[Q2b] moderationStatus claim lost for ${objectKey} (current=${current?.moderationStatus ?? 'unset'}); skipping re-scan (owned by another invocation)`
        );
      } else {
        const result = await scanUploadedObject({ fabFile: metadata, objectKey, logger });
        // blockReason travels with the verdict (vs. just logging) so ops can distinguish an
        // unscannable format from a confirmed-explicit match without CloudWatch.
        verdictPatch = toVerdictPatch(result);
        if (result.correctedMimeType && result.correctedMimeType !== metadata.mimeType) {
          // Persist the byte-sniffed real type so downstream consumers (e.g.
          // isImageServeable) see the truth instead of the client-declared mimeType. Left on
          // `metadata` (so the save below writes it, and the isMediaOnlyMimeType check after the
          // transaction sees it) rather than folded into the guarded verdict: unlike the verdict, a
          // sniffed type is derived from the bytes, so a superseded write only ever restates what
          // the successor computes.
          metadata.mimeType = result.correctedMimeType;
        }
        if (result.blockReason) logger.warn(`[Q2b] ${objectKey} blocked with reason=${result.blockReason}`);
        // 'pending' on a superseded claim, matching the losing-claim branch above: the client reads
        // it as "not yet servable, keep waiting", and the successor reports the real verdict.
        moderationStatus = (await writeVerdict(verdictPatch, session)) ? result.moderationStatus : 'pending';
      }

      // A won claim records the measured size as `fileSize` itself; a late event for an earlier write
      // of the same path loses the claim and leaves the newer write's size alone.
      await chargeUploadedObject(metadata._id, user, object.size, uploadedAt, statusBeforeUpload, session);
      await Promise.all([metadata.save({ session }), user.save({ session })]);

      return user;
    });
    // No owner means no charge and no retry, so nothing is left to judge by the old status.
    if (!user && deferStatusFlip) await markComplete();

    // The lakes this file's meta-tags name can count it as soon as the bytes are known to have
    // landed - same reason the status write moved up, and every site that marks a FabFile
    // 'complete' owes this call. Does not depend on the owner resolving.
    await recomputeStatsForUploadedFile(metadata, { logger });

    if (!user) continue;

    // sendToClient must be outside the transaction to avoid
    // Connection.find() inheriting a committed transaction session
    await sendToClient(user.id, wsEndpoint, {
      action: 'update_current_user',
      user: {
        currentStorageSize: user.currentStorageSize,
      },
    });

    await sendToClient(user.id, wsEndpoint, {
      action: 'image_moderation_status',
      fabFileId: metadata.id,
      moderationStatus,
    });

    // Track batch progress if file belongs to a data lake batch.
    // Atomic claim (pending -> uploaded) gates the counter increment, so a redelivered
    // S3 event is a true no-op (the second claim loses and we skip the increment).
    if (metadata.batchId) {
      try {
        const claimed = await dataLakeBatchRepository.claimFileStatus(
          metadata.batchId,
          metadata.id,
          ['pending'],
          'uploaded'
        );
        if (claimed) {
          const updated = await dataLakeBatchRepository.incrementCounter(metadata.batchId, 'uploadedFiles');
          await sendToClient(user.id, wsEndpoint, {
            action: 'data_lake_batch_progress',
            batchId: metadata.batchId,
            uploadedFiles: updated?.uploadedFiles ?? 1,
          });
        }
      } catch (error) {
        logger.error(`Error updating batch progress for batchId ${metadata.batchId}: ${error}`);
      }
    }

    const enableKnowledgeAutoChunk = await adminSettingsRepository.getSettingsValue('enableAutoChunk');

    // Audio and video (generated media) are never chunked/vectorized - they are
    // not attachable to an LLM, and the chunker would only produce 0 chunks.
    // Skip the enqueue so audio doesn't make a wasteful no-op queue round-trip.
    if (enableKnowledgeAutoChunk && !isMediaOnlyMimeType(metadata.mimeType)) {
      try {
        const queueUrl = Resource.fabFileChunkQueue.url;
        if (!queueUrl) throw new Error('Chunk queue URL not found');

        // No chunkSize: the chunker's passage-granularity default applies (#1420).
        const messageId = await sendToQueue(queueUrl, {
          fabFileId: metadata._id,
          userId: metadata.userId,
        });
        logger.info(`Sent newly-uploaded FabFile to chunkQueue: ${messageId}`);
      } catch (error) {
        logger.error(`Error sending newly-uploaded FabFile to chunkQueue: ${error}`);
      }
    } else if (metadata.batchId) {
      // A skipped file never reaches the chunk/vectorize handlers, so it would never
      // satisfy the batch completion threshold on its own - the batch would hang until
      // the stuck-batch reconciler forces it terminal. Count it here instead, mirroring
      // the zero-chunk accounting in fabFileChunk.ts.
      try {
        const claimed = await dataLakeBatchRepository.claimFileStatus(
          metadata.batchId,
          metadata.id,
          ['uploaded', 'pending'],
          'skipped'
        );
        if (claimed) {
          const batch = await dataLakeBatchRepository.incrementCounter(metadata.batchId, 'skippedFiles');
          await finalizeBatchIfComplete(batch, logger);
          await sendToClient(user.id, wsEndpoint, {
            action: 'data_lake_batch_progress',
            batchId: metadata.batchId,
            skippedFiles: batch?.skippedFiles ?? 1,
            status: completedBatchStatus(batch),
          });
        }
      } catch (error) {
        logger.error(`Error finalizing skipped file in batch: ${error}`);
      }
    }

    logger.log(`Updated status for file: ${objectKey}`);
  }
});
