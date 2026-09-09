import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { FabFile, adminSettingsRepository } from '@bike4mind/database';
import { decodeS3Key, findWithRetry } from '@server/s3/utils';
import { sendToQueue } from '@server/utils/sqs';
import { recomputeStatsForUploadedFile } from '@server/dataLakes/recomputeStatsForUploadedFile';
import { dispatch as historyUploadComplete } from '@server/s3/historyUploadComplete';
import { dispatch as notebookImportComplete } from '@server/s3/notebookImportComplete';
import { Resource } from 'sst';
import type { Context, S3Event } from 'aws-lambda';
import crypto from 'crypto';

/**
 * Self-host S3 ObjectCreated webhook.
 *
 * In AWS, an S3 ObjectCreated event invokes objectCreated.ts (server/s3) to mark the
 * FabFile complete and kick off RAG ingestion. Self-host has no S3 events: MinIO instead
 * POSTs an S3-compatible notification here (configured via MINIO_NOTIFY_WEBHOOK_* in
 * compose.selfhost.yaml + an `mc event add` on the fab-file bucket). This mirrors the
 * essential objectCreated path - mark complete, enqueue chunking - but skips Rekognition
 * image moderation (no AWS Rekognition in self-host). A scheduler scan in the worker is
 * the safety net for any notification that doesn't arrive.
 *
 * Self-host only (404 otherwise) and guarded by a shared secret (INTERNAL_S3_WEBHOOK_SECRET)
 * that MinIO sends in the Authorization header; browsers never learn it.
 */

interface MinioS3Record {
  s3?: { bucket?: { name?: string }; object?: { key?: string } };
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

    // Keep in sync with server/s3/objectCreated.ts and appFileUploadComplete.ts.
    const isSkippable = (key: string) =>
      key.includes('/backups/') ||
      key.startsWith('temp/') ||
      key.startsWith('tmp/') ||
      key.startsWith('exports/') ||
      key.startsWith('proxied-images/') ||
      key.startsWith('tavern-sounds/') ||
      key.startsWith('cc-bridge/') ||
      key.startsWith('cc-bridge-downloads/');

    const records = ((req.body as { Records?: MinioS3Record[] } | undefined)?.Records ?? []) as MinioS3Record[];

    // Route each record to the handler its bucket owns before any fab-file work happens. A record
    // with no bucket name keeps the historical behaviour (fab-file), so this cannot regress the
    // one path that already worked.
    const fabFileRecords: MinioS3Record[] = [];
    const forHandler: Array<{ name: string; run: (e: S3Event, c: Context) => Promise<unknown>; record: MinioS3Record }> =
      [];

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

    for (const record of fabFileRecords) {
      const rawKey = record.s3?.object?.key;
      if (!rawKey) continue;
      // MinIO URL-encodes the key like S3 does.
      const objectKey = decodeS3Key(rawKey);

      if (isSkippable(objectKey)) {
        req.logger.info(`Skipping S3 webhook for untracked file: ${objectKey}`);
        continue;
      }

      // Retry/backoff: the notification can beat the metadata write.
      const metadata = await findWithRetry(() => FabFile.findOne({ filePath: objectKey }), 4, 500);
      if (!metadata) {
        req.logger.warn(`Metadata not found for uploaded file: ${objectKey}`);
        continue;
      }

      metadata.status = 'complete';
      await metadata.save();
      req.logger.info(`Marked FabFile complete: ${metadata.id} (${objectKey})`);

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
    }

    return res.status(200).json({ ok: true });
  })
);

export default handler;
