import { AppFile } from '@bike4mind/database';
import { decodeS3Key, findWithRetry, withContext } from '@server/s3/utils';

export const func = withContext(async (event, context, logger) => {
  for (const record of event.Records) {
    const { object } = record.s3;
    const objectKey = decodeS3Key(object.key);

    logger.updateMetadata({ objectKey });

    // Skip keys that intentionally have no AppFile metadata record.
    // - backup/temp files: excluded by design
    // - exports/: quest/plan exports uploaded directly by queue handlers and
    //   delivered to users via WebSocket URL (no AppFile record is created)
    // - proxied-images/: external image cache written by cacheExternalImage util
    // - tavern-sounds/: music & ambiance files uploaded via presigned URLs in
    //   seed.ts/promote.ts without AppFile records (streamed directly from S3)
    // - cc-bridge/: compiled binaries uploaded via upload-binaries.ts CLI script
    // - cc-bridge-downloads/: per-user zip bundles created by the download endpoint
    //   (no AppFile records; served directly from S3)
    // - transcribe-uploads/: transient audio uploads for /api/ai/transcribe
    //   (consumed and deleted by the endpoint; no AppFile records)
    // - transcripts/: AWS Transcribe job outputs (consumed and deleted by
    //   speechService; no AppFile records)
    // - app-config/: public settings config artifact written by
    //   publicSettingsArtifact.ts (M2.5); a system file served via CDN, never an AppFile
    if (
      objectKey.includes('/backups/') ||
      objectKey.startsWith('temp/') ||
      objectKey.startsWith('tmp/') ||
      objectKey.startsWith('exports/') ||
      objectKey.startsWith('proxied-images/') ||
      objectKey.startsWith('tavern-sounds/') ||
      objectKey.startsWith('cc-bridge/') ||
      objectKey.startsWith('cc-bridge-downloads/') ||
      objectKey.startsWith('transcribe-uploads/') ||
      objectKey.startsWith('transcripts/') ||
      objectKey.startsWith('app-config/')
    ) {
      logger.info(`Skipping S3 event for untracked file: ${objectKey}`);
      continue;
    }

    // Search for related metadata with retry/backoff to handle race conditions
    // where the S3 event fires before the metadata write is replicated.
    // 4 retries with 500ms initial delay (~7.5s total backoff) fits within
    // the Lambda's default timeout while maximising lookup attempts.
    const metadata = await findWithRetry(() => AppFile.findOne({ path: objectKey }), 4, 500);

    if (!metadata) {
      logger.error(`Metadata not found for file: ${objectKey}`);
      continue;
    }

    logger.updateMetadata({ appFileId: metadata.id, ownerId: metadata.userId });

    metadata.status = 'complete';
    await metadata.save();

    logger.log(`Updated status for file: ${objectKey}`);
  }
});
