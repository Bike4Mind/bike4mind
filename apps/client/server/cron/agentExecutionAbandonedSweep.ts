/**
 * Agent Execution Abandoned Sweep
 *
 * Marks agent executions stuck in active statuses (no natural exit path) past
 * the staleness threshold as `failed` with `failureReason: 'abandoned'`.
 *
 * Why this exists: the reactive sweep in `agentExecute.handleStart` only fires
 * when the same user dispatches another execution. Users who abandon the tab
 * and never come back leak slots indefinitely without this cron.
 *
 * Threshold is intentionally much longer than the reactive 20-minute sweep:
 * the reactive path optimizes for unblocking active users and writes
 * `aborted` (matching the existing UI handling), while this path exists to
 * release truly-orphaned records and writes `failed`/`failureReason:
 * 'abandoned'` so operators can distinguish swept docs from real failures.
 *
 * Marking abandonment and settling the quest it left behind are two separate
 * writes, and the first one is terminal - so a settlement that fails (a
 * transient Mongo blip, say) cannot be retried by re-running the same
 * `findStaleActiveIds` query on the next tick, ever. Each run also retries
 * any execution still carrying a `questSettlementFailedAt` marker from an
 * earlier tick, independent of that query, until it succeeds.
 *
 * Schedule: every hour
 * Enabled: production + dev
 */

import { connectDB, agentExecutionRepository } from '@bike4mind/database';
import { settleStrandedQuests } from '@server/utils/settleStrandedQuests';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'agentExecutionAbandonedSweep' } });

const STALENESS_HOURS = 6;
const CLOUDWATCH_NAMESPACE = 'Lumina5/AgentExecutions';

/**
 * Per-tick cap on the settlement-retry pass, mirroring `markAbandoned`'s chunk
 * bound. The pass runs every tick, so a capped scan self-corrects on the next
 * run rather than needing to drain the whole backlog in one go.
 */
const QUEST_SETTLEMENT_RETRY_LIMIT = 200;

/**
 * Age past which a still-failing retry is logged at error level (and counted
 * in a distinct metric) instead of blending into routine warn-level retries -
 * a settlement stuck this long points at something other than a transient
 * Mongo blip and needs a human, not another silent hourly attempt.
 */
const QUEST_SETTLEMENT_STUCK_MS = 24 * 60 * 60 * 1000;

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runAbandonedExecutionSweep();
}

export async function runAbandonedExecutionSweep({ emitMetrics = true } = {}) {
  const stage = Resource.App.stage;
  // Captured before any writes: the retry pass below excludes markers written by this
  // same call, so a failure only becomes retry-eligible on a later tick.
  const tickStartedAt = new Date();
  logger.info('[AgentExecutionAbandonedSweep] Starting sweep', { stage, stalenessHours: STALENESS_HOURS });

  const metric = async (name: string, value: number) => {
    if (emitMetrics) await emitMetric(CLOUDWATCH_NAMESPACE, name, value, { Stage: stage }, StandardUnit.Count);
  };

  const olderThan = new Date(Date.now() - STALENESS_HOURS * 60 * 60 * 1000);
  const staleIds = await agentExecutionRepository.findStaleActiveIds({ olderThan });

  // Emit a heartbeat metric every run so the absence of data points alarms.
  // Operators monitor for sweeps suddenly stopping (cron broken) or spiking
  // (regression introduced misclassification), so we emit even the zero case.
  await metric('AbandonedSweepRuns', 1);

  // No early return on an empty sweep: every metric below has to report its zero
  // case for the same reason the heartbeat does - operators watch for data points
  // stopping, and a quiet hour must look different from a broken cron.
  const marked = await agentExecutionRepository.markAbandoned(staleIds, olderThan);
  if (staleIds.length === 0) {
    logger.info('[AgentExecutionAbandonedSweep] No stale executions found');
  } else {
    logger.warn('[AgentExecutionAbandonedSweep] Marked abandoned', {
      candidates: staleIds.length,
      marked: marked.length,
    });
  }
  await metric('MarkedAbandoned', marked.length);

  const quests = await settleStrandedQuests(
    marked.map(m => m.id),
    logger,
    '[AgentExecutionAbandonedSweep]'
  );
  await metric('StrandedQuestsSettled', quests.settled);
  // Emitted separately so a crashed settle pass is visible on the dashboard: it
  // and a legitimate no-op both settle 0, and only this tells them apart.
  await metric('StrandedQuestSettleFailures', quests.failed ? 1 : 0);

  // The executions above are already terminal (markAbandoned already wrote
  // `failed`), so a settlement failure here has no other path back - persist
  // the marker so the retry pass below (and future ticks) can find it again.
  if (quests.failedExecutionIds.length > 0) {
    await agentExecutionRepository.markQuestSettlementFailed(quests.failedExecutionIds);
  }

  const retrySettled = await retryFailedQuestSettlements(metric, tickStartedAt);

  return { status: 'OK', marked: marked.length, questsSettled: quests.settled + retrySettled };
}

/**
 * Re-attempts settlement for executions carrying a `questSettlementFailedAt`
 * marker from a previous tick. Independent of `findStaleActiveIds` - these
 * executions are terminal and would never surface there again.
 */
async function retryFailedQuestSettlements(
  metric: (name: string, value: number) => Promise<void>,
  tickStartedAt: Date
): Promise<number> {
  const candidates = await agentExecutionRepository.findFailedQuestSettlementIds({
    limit: QUEST_SETTLEMENT_RETRY_LIMIT,
    olderThan: tickStartedAt,
  });
  await metric('QuestSettlementRetryBacklog', candidates.length);
  if (candidates.length === 0) return 0;

  const now = Date.now();
  const stuck = candidates.filter(c => now - c.failedAt.getTime() > QUEST_SETTLEMENT_STUCK_MS);
  if (stuck.length > 0) {
    logger.error('[AgentExecutionAbandonedSweep] Quest settlement still failing past the stuck threshold', {
      count: stuck.length,
      executionIds: stuck.map(s => s.id),
    });
  }
  await metric('QuestSettlementRetryStuck', stuck.length);

  const result = await settleStrandedQuests(
    candidates.map(c => c.id),
    logger,
    '[AgentExecutionAbandonedSweep:retry]'
  );
  await metric('QuestSettlementRetrySettled', result.settled);

  const resolvedIds = candidates.map(c => c.id).filter(id => !result.failedExecutionIds.includes(id));
  if (resolvedIds.length > 0) {
    await agentExecutionRepository.clearQuestSettlementFailed(resolvedIds);
  }
  return result.settled;
}
