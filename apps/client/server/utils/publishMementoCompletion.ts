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
 * - The execution has a `parentExecutionId` OR a `spawnedByExecutionId` (subagent / DAG child); only
 *   the top-level run emits a memento event so the user's prompt is what gets
 *   evaluated - not internal coordination prompts produced by subagent
 *   dispatch. The chat-completion flow only fires on the user-authored
 *   QuestStart; mirroring that intent here keeps memento creation 1:1 with
 *   user turns. Both fields must be checked: a BACKGROUND subagent sets only
 *   `spawnedByExecutionId` (`parentExecutionId` is deliberately left unset so it bills and counts
 *   independently), and `baseFields` never copies the parent's `enableMementos` - so a child gated on
 *   `parentExecutionId` alone arrives with `enableMementos: undefined`, resolves V2 back on for any
 *   opted-in user, and writes beliefs distilled from a turn the user opted out of (#1337).
 *
 * Best-effort: a publish failure does not roll back the completion - the user
 * already saw `completed` on the wire. Errors log and swallow.
 */

import type { Logger } from '@bike4mind/observability';
import type { IAgentExecution } from '@bike4mind/database';
import type { MementoGates } from '@bike4mind/services';
import { LLMEvents } from '@server/utils/eventBus';
import {
  resolveExecutionMementoGates,
  type MementoGateAdapters,
  type MementoGateExecution,
} from './resolveExecutionMementoGates';

export type MementoCompletionExecution = Pick<
  IAgentExecution,
  'id' | 'userId' | 'sessionId' | 'questId' | 'query' | 'model' | 'parentExecutionId' | 'spawnedByExecutionId'
>;

export async function publishMementoCompletion(
  execution: MementoCompletionExecution,
  // `v2OptInLookupFailed` is optional so a caller with plain resolved gates stays valid; absent means
  // "not known to have failed", which is the safe reading - we only relax to the subscriber on a
  // POSITIVE failure signal from `resolveExecutionMementoGates`.
  gates: MementoGates & { v2OptInLookupFailed?: boolean },
  logger: Logger
): Promise<void> {
  if (execution.parentExecutionId || execution.spawnedByExecutionId) return;

  if (!gates.v1 && !gates.v2) return;

  // A `v2: false` produced by a FAILED opt-in lookup is not a real opt-out, so we must not assert it:
  // publishing `enableMementosV2: false` would tell the subscriber the user is opted out and cost them a
  // turn of V2 learning over a transient blip. Omitting the field instead hands the resolution back to
  // the subscriber, which resolves the opt-in independently. Only reachable when V1 carries the event on
  // its own - if both gates are off we returned above and there is no event to attach anything to.
  const deferV2ToSubscriber = gates.v2OptInLookupFailed === true;

  try {
    await LLMEvents.CompletionCompleted.publish({
      questId: execution.questId,
      sessionId: execution.sessionId,
      userId: execution.userId,
      prompt: execution.query,
      model: execution.model,
      // Explicit resolved gates - the subscriber writes exactly these, no defaulting.
      enableMementos: gates.v1,
      ...(deferV2ToSubscriber ? {} : { enableMementosV2: gates.v2 }),
    });
    logger.info('[Mementos] Published completion event', {
      executionId: execution.id,
      enableMementos: gates.v1,
      enableMementosV2: deferV2ToSubscriber ? 'deferred-to-subscriber (opt-in lookup failed)' : gates.v2,
    });
  } catch (err) {
    logger.warn('[Mementos] Failed to publish completion event — memento creation skipped', {
      executionId: execution.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve the memory policy and publish, as ONE step.
 *
 * Both terminal write paths (the executor's natural completion and the websocket stop-at-gate) call
 * this rather than resolving gates themselves. That is deliberate: when the two steps were separate,
 * every call site held a `MementoGates` value it could have fabricated, and nothing failed if it did -
 * hardcoding `{ v1: true, v2: true }` at all three wiring points left the entire suite green, so the
 * opt-out could be reverted invisibly. Composing them here removes the value from the call sites
 * altogether, which is a stronger guarantee than a test asserting they passed the right one (#1337).
 */
export async function resolveAndPublishMementoCompletion(
  execution: MementoCompletionExecution & MementoGateExecution,
  adapters: MementoGateAdapters,
  logger: Logger
): Promise<void> {
  const gates = await resolveExecutionMementoGates(execution, adapters, logger);
  await publishMementoCompletion(execution, gates, logger);
}
