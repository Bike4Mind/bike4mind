/**
 * Extract the agent's complete final answer from a checkpoint's `steps[]`.
 *
 * Historical `ReActAgent` builds pushed a `final_answer` step per streamed
 * delta in the no-tool branch, each holding the accumulated text up to that
 * point - so a persisted `steps[]` can end with multiple `final_answer`
 * entries with progressively-longer content. The agent now defers the
 * final-answer decision until the stream completes (single step), but old
 * checkpoints persist and `findLast` stays as defense-in-depth: the last
 * entry holds the complete reply. Using `.find` here returned the first
 * chunk (e.g. `"Based"`) and surfaced as truncated chat history after
 * refresh.
 *
 * Used by the three persistence sites that close out an agent run
 * (`processExecution` normal completion + user-abort, gate-response stop).
 */
import type { AgentStep } from '@bike4mind/agents';

export function extractFinalAnswer(steps: readonly AgentStep[]): string | undefined {
  return steps.findLast(s => s.type === 'final_answer')?.content;
}
