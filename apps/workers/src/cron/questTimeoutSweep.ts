/**
 * Quest Timeout Sweep
 *
 * Server-side backstop that resolves quests stuck at `status: 'running'` past
 * the liveness threshold. The primary read-time recovery (GET /api/quests/[id])
 * handles API clients that poll, but a quest no client ever reads again stays
 * stuck forever without this cron.
 *
 * Uses the same pure decision function (`resolveQuestTimeoutRecovery`) as the
 * read path so the recovery semantics are defined in exactly one place.
 *
 * Also the backstop for generation completion callbacks: every run re-dispatches
 * settled quests whose callback is still `pending` (a settle site that died before
 * its claim, or an enqueue that failed), and re-enqueues ones stuck at `dispatched`
 * past the delivery window (a claim whose message never reached the queue), whether
 * or not any quest was stuck.
 *
 * Schedule: every 5 minutes
 * Enabled: production + dev
 * Self-host: the worker runs `runQuestTimeoutSweep` on the same cadence (apps/workers/src/selfhost/questTimeoutSweep.ts).
 */

import { connectDB, questRepository } from '@bike4mind/database';
import { QUESTS_NAMESPACE, QUEST_METRICS, type QuestMetricName } from '@bike4mind/infra';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import { resolveQuestTimeoutRecovery, QUEST_TIMEOUT_THRESHOLD_MS } from '@server/chatCompletion/questTimeoutRecovery';
import {
  dispatchQuestCallback,
  GENERATION_CALLBACK_MAX_REDISPATCHES,
  GENERATION_CALLBACK_REDISPATCH_HORIZON_MS,
  GENERATION_CALLBACK_STALE_DISPATCH_MS,
  redispatchStaleQuestCallback,
} from '@server/generationCallback/dispatchQuestCallback';

const logger = new Logger({ metadata: { service: 'questTimeoutSweep' } });

/**
 * Oldest quest a steady-state pass will touch. Without a floor the first runs
 * after deploy would rewrite the entire historical backlog of runs abandoned at
 * `running` - a one-time backfill wearing the same metric as ongoing recovery,
 * so nothing on a dashboard could tell the two apart. Draining history is a
 * deliberate one-off, not something a 5-minute cron does by surprise.
 */
const SWEEP_AGE_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-run candidate cap. Passed explicitly rather than left to the repository
 * default so a capped run is detectable here, next to the metric that reports it.
 */
const SWEEP_LIMIT = 500;

/**
 * A settled quest's callback left `pending` this long was missed by its settle site (a Lambda
 * that died between the terminal write and the claim, or an enqueue that failed). Long enough
 * that the settle site's own dispatch has certainly run.
 */
const CALLBACK_BACKSTOP_GRACE_MS = 2 * 60 * 1000;
const CALLBACK_BACKSTOP_LIMIT = 100;

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[QuestTimeoutSweep] Starting sweep', { stage });

  // Ahead of the connect and the query, so a sweep that cannot reach the database
  // still reports as a run. Emitted after them, a totally broken sweep looks
  // identical to one that was never scheduled.
  await emitMetric(QUESTS_NAMESPACE, QUEST_METRICS.TimeoutSweepRuns, 1, { Stage: stage }, StandardUnit.Count);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));
  return runQuestTimeoutSweep();
}

/**
 * The sweep against an already-open connection. The self-host worker passes
 * `emitMetrics: false`: it has no CloudWatch, so a PutMetricData there only waits
 * on a credential lookup before logging a failure.
 */
export async function runQuestTimeoutSweep({ emitMetrics = true } = {}) {
  const stage = Resource.App.stage;
  const metric = async (name: QuestMetricName, value: number) => {
    if (emitMetrics) await emitMetric(QUESTS_NAMESPACE, name, value, { Stage: stage }, StandardUnit.Count);
  };

  const nowMs = Date.now();
  const staleQuests = await questRepository.findStaleRunning({
    olderThan: new Date(nowMs - QUEST_TIMEOUT_THRESHOLD_MS),
    newerThan: new Date(nowMs - SWEEP_AGE_FLOOR_MS),
    limit: SWEEP_LIMIT,
  });

  // Candidate depth is its own metric because `recovered` cannot distinguish a
  // run that drained the backlog from one that hit the cap with more waiting -
  // the difference that matters during an incident stranding thousands of quests.
  await metric(QUEST_METRICS.TimeoutSweepCandidates, staleQuests.length);

  if (staleQuests.length >= SWEEP_LIMIT) {
    logger.warn('[QuestTimeoutSweep] Hit the per-run candidate cap; more quests may be waiting', {
      limit: SWEEP_LIMIT,
    });
  }

  let recovered = 0;

  for (const quest of staleQuests) {
    const recovery = resolveQuestTimeoutRecovery(quest, nowMs);
    if (!recovery) continue;

    try {
      // Conditional on the quest still being unfinished, because this loop writes
      // one quest per round trip: a natural completion can land between the read
      // above and this write, and an unconditional patch would replace its real
      // answer with the timeout error. Counting only the writes that matched also
      // keeps the metric honest about what this run actually changed.
      const applied = await questRepository.settleIfUnfinished(quest.id, recovery);
      if (applied) {
        recovered++;
        // Error level, not warn: a stuck quest is a user-visible failure LiveOps must
        // see in the Slack error channel, which is fed by the ERROR-level subscription
        // on this function's log group (infra/logMonitor.ts).
        logger.error('[QuestTimeoutSweep] Recovered stuck quest', { questId: quest.id });
        await dispatchQuestCallback(quest.id, logger);
      }
    } catch (err) {
      logger.error('[QuestTimeoutSweep] Failed to recover quest', { questId: quest.id, err });
    }
  }

  // Not gated on having stuck quests: a missed callback is independent of timeout recovery.
  const callbacksRedispatched = await redispatchMissedCallbacks(nowMs);
  const staleCallbacksReenqueued = await redispatchStaleCallbacks(nowMs);

  logger.info('[QuestTimeoutSweep] Sweep complete', {
    candidates: staleQuests.length,
    recovered,
    callbacksRedispatched,
    staleCallbacksReenqueued,
  });
  await metric(QUEST_METRICS.TimeoutSweepRecovered, recovered);
  await metric(QUEST_METRICS.TimeoutSweepCallbacksRedispatched, callbacksRedispatched);
  // Its own metric: a message lost after its claim is a different failure from a claim never made,
  // and its rate is the one worth alerting on.
  await metric(QUEST_METRICS.TimeoutSweepStaleCallbacksReenqueued, staleCallbacksReenqueued);

  return { status: 'OK', recovered };
}

/** Backstop for generation callbacks whose settle-site dispatch never happened. */
async function redispatchMissedCallbacks(nowMs: number): Promise<number> {
  try {
    const questIds = await questRepository.findUndispatchedCallbacks({
      settledBefore: new Date(nowMs - CALLBACK_BACKSTOP_GRACE_MS),
      limit: CALLBACK_BACKSTOP_LIMIT,
    });
    for (const questId of questIds) {
      logger.warn('[QuestTimeoutSweep] Re-dispatching missed generation callback', { questId });
      await dispatchQuestCallback(questId, logger);
    }
    return questIds.length;
  } catch (err) {
    // The timeout recovery above already ran; a backstop read failure must not fail the sweep.
    logger.error('[QuestTimeoutSweep] Generation callback backstop failed', { err });
    return 0;
  }
}

/**
 * Backstop for generation callbacks claimed `dispatched` whose queue message was lost. Returns the
 * re-sends that actually went out, not the candidates read.
 */
async function redispatchStaleCallbacks(nowMs: number): Promise<number> {
  try {
    const criteria = {
      dispatchedBefore: new Date(nowMs - GENERATION_CALLBACK_STALE_DISPATCH_MS),
      dispatchedAfter: new Date(nowMs - GENERATION_CALLBACK_REDISPATCH_HORIZON_MS),
      maxRedispatches: GENERATION_CALLBACK_MAX_REDISPATCHES,
    };
    const questIds = await questRepository.findStaleDispatchedCallbacks({
      ...criteria,
      limit: CALLBACK_BACKSTOP_LIMIT,
    });
    let reenqueued = 0;
    for (const questId of questIds) {
      logger.warn('[QuestTimeoutSweep] Re-enqueueing generation callback stuck at dispatched', { questId });
      if (await redispatchStaleQuestCallback(questId, criteria, logger)) reenqueued++;
    }
    return reenqueued;
  } catch (err) {
    logger.error('[QuestTimeoutSweep] Stale generation callback backstop failed', { err });
    return 0;
  }
}
