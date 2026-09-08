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
 * Schedule: every 5 minutes
 * Enabled: production + dev
 */

import { connectDB, questRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import { resolveQuestTimeoutRecovery, QUEST_TIMEOUT_THRESHOLD_MS } from '@server/chatCompletion/questTimeoutRecovery';

const logger = new Logger({ metadata: { service: 'questTimeoutSweep' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/Quests';

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

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[QuestTimeoutSweep] Starting sweep', { stage });

  // Ahead of the connect and the query, so a sweep that cannot reach the database
  // still reports as a run. Emitted after them, a totally broken sweep looks
  // identical to one that was never scheduled.
  await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRuns', 1, { Stage: stage }, StandardUnit.Count);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const nowMs = Date.now();
  const staleQuests = await questRepository.findStaleRunning({
    olderThan: new Date(nowMs - QUEST_TIMEOUT_THRESHOLD_MS),
    newerThan: new Date(nowMs - SWEEP_AGE_FLOOR_MS),
    limit: SWEEP_LIMIT,
  });

  // Candidate depth is its own metric because `recovered` cannot distinguish a
  // run that drained the backlog from one that hit the cap with more waiting -
  // the difference that matters during an incident stranding thousands of quests.
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'TimeoutSweepCandidates',
    staleQuests.length,
    { Stage: stage },
    StandardUnit.Count
  );

  if (staleQuests.length >= SWEEP_LIMIT) {
    logger.warn('[QuestTimeoutSweep] Hit the per-run candidate cap; more quests may be waiting', {
      limit: SWEEP_LIMIT,
    });
  }

  if (staleQuests.length === 0) {
    logger.info('[QuestTimeoutSweep] No stuck quests found');
    await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRecovered', 0, { Stage: stage }, StandardUnit.Count);
    return { status: 'OK', recovered: 0 };
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
        logger.warn('[QuestTimeoutSweep] Recovered stuck quest', { questId: quest.id });
      }
    } catch (err) {
      logger.error('[QuestTimeoutSweep] Failed to recover quest', { questId: quest.id, err });
    }
  }

  logger.info('[QuestTimeoutSweep] Sweep complete', {
    candidates: staleQuests.length,
    recovered,
  });
  await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRecovered', recovered, { Stage: stage }, StandardUnit.Count);

  return { status: 'OK', recovered };
}
