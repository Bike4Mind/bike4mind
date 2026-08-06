import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { extractLakeMemoryForBatch } from '@server/dataLakes/extractLakeMemory';
import { z, ZodError } from 'zod';

const LakeMemoryPayload = z.object({
  batchId: z.string(),
  dataLakeId: z.string(),
  userId: z.string(),
});

/**
 * Background lake-memory extraction for a data-lake batch (#1440 producer), triggered once by
 * `finalizeBatchIfComplete` after ingest, gated on the `EnableLakeMemory` admin flag and a per-lake
 * daily cap (see enqueueLakeMemoryExtractionIfWanted). Never blocks upload. Re-scans the whole lake and
 * relies on the ledger's semantic de-dup for idempotency, so a redelivery is safe.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  try {
    const payload = LakeMemoryPayload.parse(JSON.parse(event.Records[0].body));
    logger.updateMetadata({ handler: 'lakeMemoryExtraction', dataLakeId: payload.dataLakeId, userId: payload.userId });

    await extractLakeMemoryForBatch({ dataLakeId: payload.dataLakeId }, logger);
  } catch (err) {
    // Permanently-invalid message (malformed payload) - retrying can't fix it.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping lake-memory extraction message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB/network/LLM - let SQS retry, then DLQ.
  }
});
