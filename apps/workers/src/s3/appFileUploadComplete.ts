import { AppFile } from '@bike4mind/database';
import { decodeS3Key, findWithRetry, withContext } from '@bike4mind/server-utils/s3/utils';
import { isUntrackedAppFileKey } from '@bike4mind/server-utils/s3/untrackedAppFileKey';

export const func = withContext(async (event, context, logger) => {
  for (const record of event.Records) {
    const { object } = record.s3;
    const objectKey = decodeS3Key(object.key);

    logger.updateMetadata({ objectKey });

    if (isUntrackedAppFileKey(objectKey)) {
      logger.info(`Skipping S3 event for untracked file: ${objectKey}`);
      continue;
    }

    // Search for related metadata with retry/backoff to handle race conditions
    // where the S3 event fires before the metadata write is replicated.
    // 4 retries with 500ms initial delay (~7.5s total backoff) fits within
    // the Lambda's default timeout while maximising lookup attempts.
    const metadata = await findWithRetry(() => AppFile.findOne({ path: objectKey }), 4, 500);

    // Every tracked writer creates the AppFile row before issuing the upload, so a miss here is
    // not a replication race: it is an untracked writer missing from UNTRACKED_APP_FILE_PREFIXES.
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
