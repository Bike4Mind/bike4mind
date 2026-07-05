import {
  adminSettingsRepository,
  changeStorageSize,
  dataLakeBatchRepository,
  FabFile,
  imageModerationIncidentRepository,
  User,
  withTransaction,
} from '@bike4mind/database';
import { moderateImageOrThrow } from '@bike4mind/services';
import { decodeS3Key, findWithRetry, withContext } from '@server/s3/utils';
import { getSettingsMap, getSettingsValue, RekognitionImageModerationService } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import { moderateUploadedFile } from '@server/s3/moderateUploadedFile';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';

export const func = withContext(async (event, context, logger) => {
  const wsEndpoint = Resource.websocket.managementEndpoint;

  for (const record of event.Records) {
    const { object } = record.s3;
    const objectKey = decodeS3Key(object.key);

    logger.updateMetadata({ objectKey });

    // Skip files that intentionally have no FabFile metadata record.
    // Keep in sync with appFileUploadComplete.ts skip list.
    if (
      objectKey.includes('/backups/') ||
      objectKey.startsWith('temp/') ||
      objectKey.startsWith('tmp/') ||
      objectKey.startsWith('exports/') ||
      objectKey.startsWith('proxied-images/') ||
      objectKey.startsWith('tavern-sounds/') ||
      objectKey.startsWith('cc-bridge/') ||
      objectKey.startsWith('cc-bridge-downloads/')
    ) {
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
    const scanClaimed = await FabFile.findOneAndUpdate(
      { _id: metadata._id, moderationStatus: { $in: ['pending', null] } },
      { $set: { moderationStatus: 'scanning' } },
      { new: true }
    );

    // Captured inside the transaction below; used for the ws emit afterward.
    // (`metadata.moderationStatus` itself is typed optional - pre-existing documents predate
    // the field - so the emit reads this guaranteed-defined local instead.) Stays 'pending'
    // for a losing-claim invocation that finds the file still mid-scan elsewhere: from the
    // client's perspective both 'pending' and 'scanning' mean "not yet servable, keep
    // waiting" - the eventual clean/blocked verdict is reported by whichever invocation
    // actually owns the scan.
    let moderationStatus: 'pending' | 'clean' | 'blocked' = 'pending';

    const user = await withTransaction(async session => {
      const user = await User.findById(metadata.userId).session(session);
      if (!user) {
        logger.warn(`Associated user ${metadata.userId} for newly uploaded file ${objectKey} not found`);
        return null;
      }

      // Scan uploaded images before serving them. Uploads are presigned
      // direct-to-S3 - the server never sees the bytes until this event fires, so this
      // is the only point where a moderation scan can gate the file becoming serveable.
      //
      // S3 ObjectCreated is at-least-once delivery - a redelivered event must
      // NOT re-scan and potentially overwrite an already-terminal verdict (Rekognition
      // confidence jitter right at the threshold could flip a previously 'blocked' file to
      // 'clean' on redelivery, a silent un-quarantine).
      if (moderationStatus !== 'pending') {
        // Retry guard: withTransaction retries this callback on a transient transaction
        // error. If we already completed a scan in a prior attempt of THIS invocation, reuse
        // that verdict instead of re-invoking Rekognition a second time.
        metadata.moderationStatus = moderationStatus;
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
        logger.info(
          `[Q2b] moderationStatus claim lost for ${objectKey} (current=${current?.moderationStatus ?? 'unset'}); skipping re-scan (owned by another invocation)`
        );
      } else {
        const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
        const result = await moderateUploadedFile({
          userId: metadata.userId,
          fabFileId: metadata.id,
          mimeType: metadata.mimeType,
          enabled: getSettingsValue('ImageModerationEnabled', settings) ?? true,
          service: new RekognitionImageModerationService(logger),
          incidents: imageModerationIncidentRepository,
          downloadBytes: () => getFilesStorage().download(objectKey),
          downloadPartialBytes: length => getFilesStorage().downloadRange(objectKey, length),
          moderateImageOrThrow,
          logger,
        });
        moderationStatus = result.moderationStatus;
        metadata.moderationStatus = moderationStatus;
        if (result.correctedMimeType && result.correctedMimeType !== metadata.mimeType) {
          // Persist the byte-sniffed real type so downstream consumers (e.g.
          // isImageServeable) see the truth instead of the client-declared mimeType.
          metadata.mimeType = result.correctedMimeType;
        }
        if (result.blockReason) {
          // Persist why it was blocked (vs. just logging) so ops can
          // distinguish an unscannable format from a confirmed-explicit match without
          // CloudWatch.
          metadata.blockReason = result.blockReason;
          logger.warn(`[Q2b] ${objectKey} blocked with reason=${result.blockReason}`);
        }
      }

      metadata.status = 'complete';
      changeStorageSize(user, object.size);
      await Promise.all([metadata.save({ session }), user.save({ session })]);

      return user;
    });

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

    if (enableKnowledgeAutoChunk) {
      try {
        const queueUrl = Resource.fabFileChunkQueue.url;
        if (!queueUrl) throw new Error('Chunk queue URL not found');

        const messageId = await sendToQueue(queueUrl, {
          fabFileId: metadata._id,
          userId: metadata.userId,
          chunkSize: '1000',
        });
        logger.info(`Sent newly-uploaded FabFile to chunkQueue: ${messageId}`);
      } catch (error) {
        logger.error(`Error sending newly-uploaded FabFile to chunkQueue: ${error}`);
      }
    }

    logger.log(`Updated status for file: ${objectKey}`);
  }
});
