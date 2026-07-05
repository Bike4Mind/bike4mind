/**
 * Extract the agent's complete final answer from a checkpoint's `steps[]`.
 *
 * The streaming LLM callback in `ReActAgent` pushes a `final_answer` step
 * per delta in the no-tool branch, each holding the accumulated text up to
 * that point - so the array can end with multiple `final_answer` entries
 * with progressively-longer content. The last one holds the complete reply;
 * using `.find` here returned the first chunk (e.g. `"Based"`) and surfaced
 * as truncated chat history after refresh.
 *
 * Used by the three persistence sites that close out an agent run
 * (`processExecution` normal completion + user-abort, gate-response stop).
 */
import type { AgentStep } from '@bike4mind/agents';

export function extractFinalAnswer(steps: readonly AgentStep[]): string | undefined {
  return steps.findLast(s => s.type === 'final_answer')?.content;
}
