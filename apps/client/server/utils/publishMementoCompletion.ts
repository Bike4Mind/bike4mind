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
 * - The user is on NEITHER memory pipeline. V1 is gated by `enableMementos` on the execution
 *   doc (user/admin), V2 by the user's own `enableMementosV2` opt-in - and V2 has to be
 *   checked independently, or turning V1 off would silently stop V2 from LEARNING while it
 *   carried on answering from a frozen snapshot. That is the whole point of V2 having its own
 *   write path: V1 must be switchable off, and one day deletable.
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
import { isMementosV2Enabled } from '@server/memory/mementoLedgerMirror';

export type MementoCompletionExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'sessionId' | 'questId' | 'query' | 'model' | 'enableMementos' | 'parentExecutionId'
>;

export async function publishMementoCompletion(execution: MementoCompletionExecution, logger: Logger): Promise<void> {
  if (execution.parentExecutionId) return;

  const enableMementos = execution.enableMementos === true;
  // Only pay for the opt-in lookup when V1 is off - if V1 is already capturing this turn the event
  // fires regardless, and the subscriber resolves V2 for itself.
  const enableMementosV2 = enableMementos || (await isMementosV2Enabled(execution.userId).catch(() => false));

  if (!enableMementos && !enableMementosV2) return;

  try {
    await LLMEvents.CompletionCompleted.publish({
      questId: execution.questId,
      sessionId: execution.sessionId,
      userId: execution.userId,
      prompt: execution.query,
      model: execution.model,
      enableMementos,
      // Deliberately NOT forwarded when V1 short-circuited the lookup above: the value would be a
      // lie (`true` because V1 is on, not because the user opted in). Undefined tells the subscriber
      // to resolve it properly.
      ...(enableMementos ? {} : { enableMementosV2 }),
    });
    logger.info('[Mementos] Published completion event', { executionId: execution.id, enableMementos, enableMementosV2 });
  } catch (err) {
    logger.warn('[Mementos] Failed to publish completion event — memento creation skipped', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
