/**
 * Memento parity helper for agent_executor (write side).
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
 * The caller resolves the memory policy once, via `resolveExecutionMementoGates`, and hands us the
 * concrete `MementoGates` - the SAME resolver the read side uses and the same shape the chat path
 * resolves in ChatCompletionProcess. We publish those gates verbatim; we do not re-derive them, so no
 * surface can disagree about what `enableMementos: false` means (#1337). The completion event carries
 * explicit booleans (mirroring the chat path's `MementoFeature.onComplete`), so the subscriber writes
 * exactly the pipelines the gates allow rather than defaulting anything on.
 *
 * Skips when:
 * - Both gates are off - the user is on NEITHER pipeline for this turn (V1 off AND V2 off, whether by
 *   an explicit opt-out, no opt-in, or the admin setting). V2 has its own write flag precisely so V1
 *   can be switched off without freezing V2's learning; a resolved-off V2 gate is the one thing that
 *   stops the write.
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
import type { MementoGates } from '@bike4mind/services';
import { LLMEvents } from '@server/utils/eventBus';

export type MementoCompletionExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'sessionId' | 'questId' | 'query' | 'model' | 'parentExecutionId'
>;

export async function publishMementoCompletion(
  execution: MementoCompletionExecution,
  gates: MementoGates,
  logger: Logger
): Promise<void> {
  if (execution.parentExecutionId) return;

  if (!gates.v1 && !gates.v2) return;

  try {
    await LLMEvents.CompletionCompleted.publish({
      questId: execution.questId,
      sessionId: execution.sessionId,
      userId: execution.userId,
      prompt: execution.query,
      model: execution.model,
      // Explicit resolved gates - the subscriber writes exactly these, no defaulting.
      enableMementos: gates.v1,
      enableMementosV2: gates.v2,
    });
    logger.info('[Mementos] Published completion event', {
      executionId: execution.id,
      enableMementos: gates.v1,
      enableMementosV2: gates.v2,
    });
  } catch (err) {
    logger.warn('[Mementos] Failed to publish completion event — memento creation skipped', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
