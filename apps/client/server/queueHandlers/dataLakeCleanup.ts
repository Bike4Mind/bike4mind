import {
  dataLakeRepository,
  dataLakeBatchRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { BadRequestError } from '@bike4mind/utils';
import { z, ZodError } from 'zod';

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
  try {
    // Parse INSIDE the try: a malformed body (bad JSON / wrong shape) is permanently invalid, so
    // it must be swallowed like the other permanent errors below, not retried into the DLQ.
    const { dataLakeId, actor } = CleanupPayload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({ handler: 'dataLakeCleanup', dataLakeId, userId: actor.userId });

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
    // Permanently-invalid message - malformed payload (SyntaxError/ZodError) or a failed guard
    // (BadRequestError: not owner, or lake not in 'deleted'). Retrying can't fix any of these, so
    // swallow with a WARN rather than burn retries into the DLQ. Everything else (DB/network)
    // rethrows so SQS retries then DLQs.
    if (err instanceof BadRequestError || err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping data-lake cleanup message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err;
  }
});
