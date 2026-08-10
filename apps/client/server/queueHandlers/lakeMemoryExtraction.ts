import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { extractLakeMemoryForBatch } from '@server/dataLakes/extractLakeMemory';
import { LAKE_MEMORY_MAX_CONTINUATION_SLICES } from '@server/dataLakes/lakeMemoryRateLimit';
import { adminSettingsRepository } from '@bike4mind/database';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import { z, ZodError } from 'zod';

const LakeMemoryPayload = z.object({
  batchId: z.string(),
  dataLakeId: z.string(),
  userId: z.string(),
  // Continuation depth: 0 for the finalize-triggered run, incremented on each self-re-enqueue. Bounds
  // the chain length (LAKE_MEMORY_MAX_CONTINUATION_SLICES) so a huge lake cannot chain unbounded. Absent
  // on the finalize enqueue, so it defaults to 0.
  slice: z.number().int().nonnegative().default(0),
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

    // Re-check the flag HERE, not just at enqueue time. The enqueue gate
    // (`enqueueLakeMemoryExtractionIfWanted`) runs when the batch finalizes, but this message can sit in
    // the queue for the full visibility window and across retries - so without this, turning the
    // kill-switch off would still let already-queued extractions write beliefs. The consumer side is
    // gated independently, so those beliefs would be inert; this makes the switch stop the WRITE too.
    // Deliberately NOT `.catch(() => false)`. Failing closed is right, but dropping the message is not:
    // a rejected lookup is "we could not tell", and collapsing that into a definitive off would delete
    // the work with no retry and no DLQ over a transient Mongo blip. Letting it throw fails closed for
    // THIS attempt (nothing is written) while leaving SQS to retry, which is the same
    // failed-lookup-is-not-a-resolved-false distinction the memento gate resolver draws on the agent
    // surface. Only a definitive `false` drops the message.
    const enabled = await adminSettingsRepository.getSettingsValue('EnableLakeMemory');
    if (!enabled) {
      logger.info('[lakeMemory] EnableLakeMemory is off; dropping queued extraction', {
        dataLakeId: payload.dataLakeId,
      });
      return;
    }

    const { hasMore } = await extractLakeMemoryForBatch(
      // Real Lambda clock, so the deadline guard accounts for cold start and time already spent.
      { dataLakeId: payload.dataLakeId, getRemainingTimeInMillis: () => context.getRemainingTimeInMillis() },
      logger
    );

    // Bounded continuation: a lake too large for one invocation persisted a cursor and asked for another
    // run. Re-enqueue the same payload with an incremented slice; the next invocation resumes from the
    // cursor and re-checks the kill-switch at entry (above), so a flag flip between slices stops the
    // chain. Progress is monotonic (the cursor only advances and a no-progress run returns hasMore:false),
    // so the chain terminates - but a pathologically large lake could still chain far enough to run up a
    // surprising LLM bill, so cap the chain length independently of that.
    if (hasMore) {
      const nextSlice = payload.slice + 1;
      if (nextSlice >= LAKE_MEMORY_MAX_CONTINUATION_SLICES) {
        // The daily cap bounds how often a chain starts; this bounds how long one chain runs. Coverage is
        // not lost: the persisted cursor lets the next batch finalize resume from where this chain
        // stopped. Log loudly so an oversized lake surfaces here rather than on a bill.
        logger.warn('[lakeMemory] continuation chain hit the slice ceiling; not enqueuing further', {
          dataLakeId: payload.dataLakeId,
          slice: payload.slice,
          maxSlices: LAKE_MEMORY_MAX_CONTINUATION_SLICES,
        });
        return;
      }
      await sendToQueue(Resource.lakeMemoryQueue.url, {
        batchId: payload.batchId,
        dataLakeId: payload.dataLakeId,
        userId: payload.userId,
        slice: nextSlice,
      });
      logger.info('[lakeMemory] enqueued continuation run for the remaining docs', {
        dataLakeId: payload.dataLakeId,
        slice: nextSlice,
      });
    }
  } catch (err) {
    // Permanently-invalid message (malformed payload) - retrying can't fix it.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping lake-memory extraction message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err; // DB/network/LLM - let SQS retry, then DLQ.
  }
});
