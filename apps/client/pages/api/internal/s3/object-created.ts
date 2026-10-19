import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, User, adminSettingsRepository, withTransaction } from '@bike4mind/database';
import { decodeS3Key, findWithRetry } from '@server/s3/utils';
import { isUntrackedFabFileKey } from '@server/s3/untrackedFabFileKey';
import { sendToQueue } from '@server/utils/sqs';
import { getFilesStorage } from '@server/utils/storage';
import { chargeUploadedObject } from '@bike4mind/server-utils/s3/storageCharge';
import { normalizeETag, recordLandedObject } from '@server/s3/moderationScan';
import { admitLandedUpload } from '@server/s3/uploadSizeGate';
import { recordRejectedUploadBatch } from '@server/s3/recordRejectedUploadBatch';
import { recomputeStatsForUploadedFile } from '@server/dataLakes/recomputeStatsForUploadedFile';
import { dispatch as historyUploadComplete } from '@server/s3/historyUploadComplete';
import { dispatch as notebookImportComplete } from '@server/s3/notebookImportComplete';
import { moderateImportedKnowledgeFiles } from '@server/s3/moderateImportedKnowledgeFiles';
import { buildKnowledgeModerationDeps } from '@server/s3/knowledgeModerationDeps';
import { Resource } from 'sst';
import type { Context, S3Event } from 'aws-lambda';
import crypto from 'crypto';

/**
 * Self-host S3 ObjectCreated webhook.
 *
 * In AWS, an S3 ObjectCreated event invokes apps/workers/src/s3/objectCreated.ts to mark the
 * FabFile complete and kick off RAG ingestion. Self-host has no S3 events: MinIO instead
 * POSTs an S3-compatible notification here (configured via MINIO_NOTIFY_WEBHOOK_* in
 * compose.selfhost.yaml + an `mc event add` on the fab-file bucket). This mirrors the
 * objectCreated path - mark complete, charge the uploader's storage, enqueue chunking, run the
 * upload-time moderation scan.
 * A file is unservable until that scan resolves it, so skipping it here held every self-host
 * file for the rescue sweep's 30-minute floor. On self-host the scan is the type sniff only:
 * the image check returns early without Rekognition (see imageModerationGate.ts). A scheduler
 * scan in the worker is the safety net for any notification that doesn't arrive.
 *
 * Self-host only (404 otherwise) and guarded by a shared secret (INTERNAL_S3_WEBHOOK_SECRET)
 * that MinIO sends in the Authorization header; browsers never learn it.
 */

interface MinioS3Record {
  eventTime?: string;
  s3?: { bucket?: { name?: string }; object?: { key?: string; size?: number; eTag?: string } };
}

/**
 * Hosted wires a separate ObjectCreated notification per bucket (infra/buckets.ts). Self-host has
 * exactly one webhook for all of them, so the bucket has to be read off the record and routed
 * here, or every event lands in the fab-file logic below. That is what happened: history-import
 * and notebook-import objects were uploaded and then silently never processed, because this
 * route was the only consumer and it only ever spoke fab-file.
 *
 * The handlers are the SAME ones hosted invokes, called with the record re-wrapped as the S3
 * event shape they already parse - no second copy of the logic, and their existing idempotency
 * (keyed on the S3 key) covers a redelivered notification.
 */
const selfHostLambdaContext = (functionName: string) =>
  ({
    awsRequestId: `selfhost-webhook-${functionName}`,
    functionName,
    functionVersion: '$LATEST',
  }) as unknown as Context;

const secretOk = (authorizationHeader: string | string[] | undefined): boolean => {
  const expected = process.env.INTERNAL_S3_WEBHOOK_SECRET;
  if (!expected) return false;
  const raw = Array.isArray(authorizationHeader) ? '' : (authorizationHeader ?? '');
  // MinIO sends the auth_token verbatim as the Authorization value; tolerate a Bearer prefix.
  const provided = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  // Compare UTF-8 byte lengths (not UTF-16 string .length): timingSafeEqual requires equal
  // byte lengths and throws otherwise, which a multi-byte value of equal string length would hit.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
};

const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req, res) => {
    if (process.env.B4M_SELF_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!secretOk(req.headers['authorization'])) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const records = ((req.body as { Records?: MinioS3Record[] } | undefined)?.Records ?? []) as MinioS3Record[];

    // Route each record to the handler its bucket owns before any fab-file work happens. A record
    // with no bucket name keeps the historical behaviour (fab-file), so this cannot regress the
    // one path that already worked.
    const fabFileRecords: MinioS3Record[] = [];
    const forHandler: Array<{
      name: string;
      run: (e: S3Event, c: Context) => Promise<unknown>;
      record: MinioS3Record;
    }> = [];

    for (const record of records) {
      const bucket = record.s3?.bucket?.name;
      if (!bucket || bucket === Resource.fabFileBucket.name) {
        fabFileRecords.push(record);
        continue;
      }
      if (bucket === Resource.historyImportBucket.name) {
        // One bucket, two handlers, split by prefix - exactly how hosted filters it.
        const key = decodeS3Key(record.s3?.object?.key ?? '');
        forHandler.push(
          key.startsWith('notebooks/')
            ? { name: 'notebookImportComplete', run: notebookImportComplete, record }
            : { name: 'historyUploadComplete', run: historyUploadComplete, record }
        );
        continue;
      }
      req.logger.info(`No self-host handler for bucket ${bucket}; ignoring object ${record.s3?.object?.key}`);
    }

    for (const { name, run, record } of forHandler) {
      // Deliberately not awaited: an import runs for minutes and hosted invokes these as an async
      // Lambda, so blocking MinIO's webhook here would time it out and provoke a redelivery. The
      // job row is written early inside the handler, so progress is still visible.
      void run({ Records: [record] } as unknown as S3Event, selfHostLambdaContext(name)).catch(err =>
        req.logger.error(`[${name}] self-host dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }

    const enableAutoChunk = await adminSettingsRepository.getSettingsValue('enableAutoChunk');
    const moderationEnabled = (await adminSettingsRepository.getSettingsValue('ImageModerationEnabled')) ?? true;

    for (const record of fabFileRecords) {
      const rawKey = record.s3?.object?.key;
      if (!rawKey) continue;
      // MinIO URL-encodes the key like S3 does.
      const objectKey = decodeS3Key(rawKey);

      if (isUntrackedFabFileKey(objectKey)) {
        req.logger.info(`Skipping S3 webhook for untracked file: ${objectKey}`);
        continue;
      }

      // Retry/backoff: the notification can beat the metadata write.
      const metadata = await findWithRetry(
        () =>
          FabFile.findOne(
            { filePath: objectKey, $or: [{ deletedAt: null }, { uploadRejectedAt: { $ne: null } }] },
            null,
            { includeDeleted: true }
          ),
        4,
        500
      );
      if (!metadata) {
        req.logger.warn(`Metadata not found for uploaded file: ${objectKey}`);
        continue;
      }

      const statusBeforeUpload = metadata.status;
      const payloadSize = record.s3?.object?.size;
      const size = metadata.uploadRejectedAt
        ? 0
        : typeof payloadSize === 'number' && Number.isFinite(payloadSize) && payloadSize >= 0
          ? payloadSize
          : (await getFilesStorage().getMetadata(objectKey)).size;
      // Unjudged bytes must not go complete; a 500 has MinIO redeliver the event.
      if (size === undefined) throw new Error(`No object size for ${objectKey}; upload not admitted`);

      // Same measured-size gate as the hosted event (objectCreated.ts), before the row is complete.
      if (!(await admitLandedUpload(metadata, size, objectKey, req.logger))) {
        await recordRejectedUploadBatch(metadata, req.logger);
        continue;
      }

      metadata.status = 'complete';
      await metadata.save();

      // Same overwrite check as the hosted event (objectCreated.ts): a re-PUT of a judged object
      // sends its verdict back to 'pending' before the scan below claims it.
      // The row is already complete, so a failed HEAD must not 500 the webhook (see the charge below).
      const eTag = normalizeETag(
        record.s3?.object?.eTag ??
          (await getFilesStorage()
            .getMetadata(objectKey)
            .then(head => head.etag)
            .catch((err: unknown) => {
              req.logger.error(`No eTag for ${objectKey}; overwrite check skipped`, err);
              return undefined;
            }))
      );
      if (eTag) await recordLandedObject(metadata._id, eTag);
      req.logger.info(`Marked FabFile complete: ${metadata.id} (${objectKey})`);

      // Charged from the stored object's size, never the row's client-claimed fileSize. The
      // storageChargedAt claim makes a redelivery free. A failure must not 500: the row is already
      // complete and a redelivery would enqueue chunking twice.
      try {
        const eventTime = record.eventTime ? new Date(record.eventTime) : undefined;
        const uploadedAt = eventTime && !isNaN(eventTime.getTime()) ? eventTime : new Date();
        await withTransaction(async session => {
          const user = await User.findById(metadata.userId).session(session);
          // A won claim records `size` as the row's fileSize, so a later refund and the recalc agree.
          if (user && (await chargeUploadedObject(metadata._id, user, size, uploadedAt, statusBeforeUpload, session))) {
            await user.save({ session });
          }
        });
      } catch (error) {
        req.logger.error(`Failed to charge storage for ${objectKey}: ${error}`);
      }

      // Mirrors the hosted event: the bytes have landed, so the lakes this file joined can be
      // counted - and, if one is still a draft, activated.
      await recomputeStatsForUploadedFile(metadata, { logger: req.logger });

      if (enableAutoChunk) {
        try {
          // No chunkSize: the chunker's passage-granularity default applies (#1420).
          await sendToQueue(Resource.fabFileChunkQueue.url, {
            fabFileId: metadata._id,
            userId: metadata.userId,
          });
          req.logger.info(`Enqueued FabFile for chunking: ${metadata.id}`);
        } catch (error) {
          req.logger.error(`Failed to enqueue FabFile for chunking: ${error}`);
        }
      }

      // The same claim/scan/persist the rescue sweep runs, so the two cannot double-scan a row. Not
      // awaited: the scan downloads the object, and holding MinIO's webhook on that invites a
      // redelivery. Deps are built inside the chain so a wiring error is logged instead of 500ing a
      // file already marked complete. A failed or lost scan leaves the file 'pending' for the sweep.
      void Promise.resolve()
        .then(() =>
          moderateImportedKnowledgeFiles({
            filePaths: [objectKey],
            userId: metadata.userId,
            enabled: moderationEnabled,
            // The bytes just landed, so a missing read is a storage blip to retry, not an orphan to retire.
            terminalOnMissingObject: false,
            ...buildKnowledgeModerationDeps(req.logger),
          })
        )
        .catch(err =>
          req.logger.error(
            `Upload moderation failed for ${objectKey}: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    }

    return res.status(200).json({ ok: true });
  })
);

export default handler;
