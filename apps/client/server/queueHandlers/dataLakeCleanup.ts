import {
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';

const CleanupPayload = z.object({
  dataLakeId: z.string(),
  actor: z.object({ userId: z.string(), isAdmin: z.boolean() }),
});

/**
 * Background consumer for the phase-2 data-lake hard-delete sweep, offloaded off the request path
 * (a large lake can blow the request Lambda's timeout). Re-runs the same guarded, idempotent
 * `cleanupDeletedDataLake` service, so a duplicate/stale delivery is safe.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const { dataLakeId, actor } = CleanupPayload.parse(JSON.parse(event.Records[0].body));
  logger.updateMetadata({ handler: 'dataLakeCleanup', dataLakeId, userId: actor.userId });

  try {
    await dataLakeService.cleanupDeletedDataLake(actor, dataLakeId, {
      db: {
        dataLakes: dataLakeRepository,
        batches: dataLakeBatchRepository,
        fabFiles: fabFileRepository,
        fabFileChunks: fabFileChunkRepository,
      },
      logger,
    });
  } catch (err) {
    // A BadRequestError is a permanently-invalid message (not owner, or lake not in 'deleted'):
    // retrying can't fix it, so swallow with a WARN rather than burn retries into the DLQ.
    // Anything else (DB/network) rethrows so SQS retries then DLQs.
    if (err instanceof BadRequestError) {
      logger.warn(`Skipping data-lake cleanup for ${dataLakeId}: ${err.message}`);
      return;
    }
    throw err;
  }
});
