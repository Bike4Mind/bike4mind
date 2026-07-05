/**
 * Memento parity helper for agent_executor.
 *
 * The chat-completion flow fires `LLMEvents.CompletionCompleted` from
 * `chatCompletionDefaults.invokeCreateMemento` on the user-authored QuestStart;
 * the `createMemento` Lambda subscribes and evaluates the prompt for facts to
 * persist. Before this hook, agent-mode prompts never reached that handler.
 *
 * This helper centralizes the publish so every terminal `completed` write in
 * the agent path - the executor's natural completion (`processExecution`) and
 * the stop-at-gate branch (`handleGateResponse`) - emits the same event with
 * the same guards and the same log line.
 *
 * Skips when:
 * - `enableMementos !== true` on the execution doc (user/admin disabled).
 * - The execution has a `parentExecutionId` (subagent / DAG child); only the
 *   top-level run emits a memento event so the user's prompt is what gets
 *   evaluated - not internal coordination prompts produced by subagent
 *   dispatch. The chat-completion flow only fires on the user-authored
 *   QuestStart; mirroring that intent here keeps memento creation 1:1 with
 *   user turns.
 *
 * Best-effort: a publish failure does not roll back the completion - the user
 * already saw `completed` on the wire. Errors log and swallow.
 */

import type { Logger } from '@bike4mind/observability';
import type { IAgentExecution } from '@bike4mind/database';
import { LLMEvents } from '@server/utils/eventBus';

export type MementoCompletionExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'sessionId' | 'questId' | 'query' | 'model' | 'enableMementos' | 'parentExecutionId'
>;

export async function publishMementoCompletion(execution: MementoCompletionExecution, logger: Logger): Promise<void> {
  if (!execution.enableMementos) return;
  if (execution.parentExecutionId) return;
  try {
    await LLMEvents.CompletionCompleted.publish({
      questId: execution.questId,
      sessionId: execution.sessionId,
      userId: execution.userId,
      prompt: execution.query,
      model: execution.model,
    });
    logger.info('[Mementos] Published completion event', { executionId: execution.id });
  } catch (err) {
    logger.warn('[Mementos] Failed to publish completion event — memento creation skipped', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
