import { agentExecutionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { settleStrandedQuests } from '@bike4mind/server-utils/utils/settleStrandedQuests';
import {
  createAgentPushDeps,
  endAgentLiveActivity,
  publishAgentTerminalPush,
} from '@workers/queueHandlers/agentExecutor.push';
import type { ExecutionTarget } from './queueMessage';

/**
 * Fails the execution a dropped message would have advanced and settles its quest, as the abandoned
 * sweep does. The sweep is not enough on its own: it waits six hours and never touches the
 * awaiting_* statuses, so a dropped wake for a waiting parent would never settle.
 *
 * Status-guarded through the same compare-and-swap the message's own claim uses, so an execution
 * that already moved on (running, finished, or aborted) is left alone. No run frame reaches the wrapped
 * sender on this path, so the run's `agent_failed` push is published, and its live activity
 * ended, here.
 */
export async function settleDroppedExecution(
  target: ExecutionTarget,
  logger: Pick<Logger, 'warn' | 'error'>
): Promise<boolean> {
  const claimed = await agentExecutionRepository.claimExecution(target.executionId, target.claimableFrom, 'failed');
  if (!claimed) return false;
  await agentExecutionRepository.markFailed(target.executionId, {
    message: 'Agent queue message dropped after repeated delivery failures',
    callerSafe: true,
  });
  const quests = await settleStrandedQuests([target.executionId], logger, '[agentExecutor:drop]');
  // The execution is terminal now, so only the sweep's marker-driven retry pass can reach its quest.
  if (quests.failedExecutionIds.length > 0) {
    await agentExecutionRepository.markQuestSettlementFailed(quests.failedExecutionIds);
  }
  const pushDeps = createAgentPushDeps(logger);
  await publishAgentTerminalPush({ executionId: target.executionId, outcome: 'failed' }, pushDeps, logger);
  await endAgentLiveActivity({ executionId: target.executionId, outcome: 'failed' }, pushDeps, logger);
  return true;
}
