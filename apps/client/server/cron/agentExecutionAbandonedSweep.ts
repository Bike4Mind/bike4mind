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

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[AgentExecutionAbandonedSweep] Starting sweep', { stage, stalenessHours: STALENESS_HOURS });

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const olderThan = new Date(Date.now() - STALENESS_HOURS * 60 * 60 * 1000);
  const staleIds = await agentExecutionRepository.findStaleActiveIds({ olderThan });

  // Emit a heartbeat metric every run so the absence of data points alarms.
  // Operators monitor for sweeps suddenly stopping (cron broken) or spiking
  // (regression introduced misclassification), so we emit even the zero case.
  await emitMetric(CLOUDWATCH_NAMESPACE, 'AbandonedSweepRuns', 1, { Stage: stage }, StandardUnit.Count);

  // No early return on an empty sweep: every metric below has to report its zero
  // case for the same reason the heartbeat does - operators watch for data points
  // stopping, and a quiet hour must look different from a broken cron.
  const marked = await agentExecutionRepository.markAbandoned(staleIds);
  if (staleIds.length === 0) {
    logger.info('[AgentExecutionAbandonedSweep] No stale executions found');
  } else {
    logger.warn('[AgentExecutionAbandonedSweep] Marked abandoned', {
      candidates: staleIds.length,
      marked: marked.length,
    });
  }
  await emitMetric(CLOUDWATCH_NAMESPACE, 'MarkedAbandoned', marked.length, { Stage: stage }, StandardUnit.Count);

  const quests = await settleStrandedQuests(
    marked.map(m => m.id),
    logger,
    '[AgentExecutionAbandonedSweep]'
  );
  await emitMetric(CLOUDWATCH_NAMESPACE, 'StrandedQuestsSettled', quests.settled, { Stage: stage }, StandardUnit.Count);
  // Emitted separately so a crashed settle pass is visible on the dashboard: it
  // and a legitimate no-op both settle 0, and only this tells them apart.
  await emitMetric(
    CLOUDWATCH_NAMESPACE,
    'StrandedQuestSettleFailures',
    quests.failed ? 1 : 0,
    { Stage: stage },
    StandardUnit.Count
  );

  return { status: 'OK', marked: marked.length, questsSettled: quests.settled };
}
