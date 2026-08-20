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

import { connectDB, agentExecutionRepository, questRepository } from '@bike4mind/database';
import { ABANDONED_REPLY, terminalRecoveryFor } from '@server/chatCompletion/questTimeoutRecovery';
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

  if (staleIds.length === 0) {
    logger.info('[AgentExecutionAbandonedSweep] No stale executions found');
    await emitMetric(CLOUDWATCH_NAMESPACE, 'MarkedAbandoned', 0, { Stage: stage }, StandardUnit.Count);
    return { status: 'OK', marked: 0 };
  }

  const marked = await agentExecutionRepository.markAbandoned(staleIds);
  logger.warn('[AgentExecutionAbandonedSweep] Marked abandoned', {
    candidates: staleIds.length,
    marked: marked.length,
  });
  await emitMetric(CLOUDWATCH_NAMESPACE, 'MarkedAbandoned', marked.length, { Stage: stage }, StandardUnit.Count);

  const strandedQuests = await settleStrandedQuests(marked.map(m => m.id));
  await emitMetric(CLOUDWATCH_NAMESPACE, 'StrandedQuestsSettled', strandedQuests, { Stage: stage }, StandardUnit.Count);

  return { status: 'OK', marked: marked.length, questsSettled: strandedQuests };
}

/**
 * Give a terminal state to the quests left behind by the executions this sweep
 * just killed.
 *
 * `markAbandoned` writes only the AgentExecution, so before this the bubble kept
 * its non-terminal status forever: the run was dead but the UI still presented
 * it as working, with no error and nothing to retry. The liveness-based recovery
 * (`resolveQuestTimeoutRecovery`) cannot reach these because it only considers
 * quests that reached `running` - a run that died before streaming sits at
 * `pending` and is invisible to it.
 *
 * Best-effort by design: a quest that fails to settle must not fail the sweep,
 * whose primary job (releasing execution slots) has already succeeded by now.
 */
export async function settleStrandedQuests(executionIds: string[]): Promise<number> {
  if (executionIds.length === 0) return 0;

  let settled = 0;
  try {
    const stranded = await questRepository.findUnfinishedByAgentExecutionIds(executionIds);
    for (const quest of stranded) {
      try {
        await questRepository.update({ id: quest.id, ...terminalRecoveryFor(quest, ABANDONED_REPLY) });
        settled += 1;
      } catch (err) {
        logger.warn('[AgentExecutionAbandonedSweep] Failed to settle stranded quest', { questId: quest.id, err });
      }
    }
    if (settled > 0) {
      logger.warn('[AgentExecutionAbandonedSweep] Settled stranded quests', { stranded: stranded.length, settled });
    }
  } catch (err) {
    logger.error('[AgentExecutionAbandonedSweep] Stranded-quest settle pass failed', { err });
  }
  return settled;
}
