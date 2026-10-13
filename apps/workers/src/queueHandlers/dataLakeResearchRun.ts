import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { runLakeResearch } from '@server/dataLakes/runLakeResearch';
import { z, ZodError } from 'zod';

const ResearchRunPayload = z.object({
  runId: z.string(),
  dataLakeId: z.string(),
});

/**
 * Executes one queued research run (#1682), enqueued by `POST /api/data-lakes/:id/research/runs`.
 *
 * Safe under SQS's at-least-once delivery WITHOUT being idempotent in the usual sense: the run row
 * is claimed with a compare-and-set on `queued`, so a redelivery of work already done finds nothing
 * to claim and returns. That matters more here than in most handlers - a second pass would spend a
 * second cost ceiling's worth of LLM calls, not just duplicate a write.
 *
 * Everything a run can fail on that a retry cannot fix (no search provider, a deleted lake, an
 * unusable model) is settled as a `failed` run with a message a lake manager can act on, rather than
 * thrown. Only genuinely transient faults reach SQS.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  let runId: string | undefined;
  try {
    const payload = ResearchRunPayload.parse(JSON.parse(event.Records[0].body));
    runId = payload.runId;
    logger.updateMetadata({
      handler: 'dataLakeResearchRun',
      runId: payload.runId,
      dataLakeId: payload.dataLakeId,
    });

    const { claimed } = await runLakeResearch(payload.runId, logger, {
      // Real Lambda clock, so the loop's time-budget stop accounts for cold start and for time
      // already spent rather than assuming a fresh invocation. Optional-chained the way
      // `driveLakeIngest` does it: a Context shim that omits the method (the cast in
      // `selfHostWorker.fakeContext` hides that from the compiler) must not become a TypeError on
      // the first candidate. A non-number reads as "no deadline", which is true of a worker.
      remainingTimeMs: () => context?.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER,
    });
    if (!claimed) {
      logger.log(`Research run ${payload.runId} was not queued (already claimed or settled) - skipping`);
    }
  } catch (err) {
    // A malformed payload can never succeed; retrying it only costs deliveries and a DLQ entry.
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping research-run message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Everything else is transient (Mongo, the provider's network). The run row is ALREADY settled
    // `failed` by runLakeResearch's own catch, so a redelivery finds it unclaimable and stops -
    // deliberately no auto-retry of the loop. Re-running would be a second ceiling of spend on the
    // strength of one transport-level blip, and the user can press Run again for far less.
    logger.error('[lakeResearch] research run failed', { runId, err });
    throw err;
  }
});
