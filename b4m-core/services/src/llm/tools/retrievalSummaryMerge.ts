import type { PromptMeta } from '@bike4mind/common';

export type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

// 'ok' outranks 'no_lakes': a turn where one surface abstained (no lakes in scope) while another
// surface actually retrieved successfully is reachable (e.g. LakeMemoryFeature abstains but
// search_knowledge_base succeeds independently), and the merged outcome must reflect the success,
// not the abstain. 'not_indexed' sits ABOVE 'ok' because an unsearchable corpus is not a topical
// zero and must not be erased by another surface's success in the same turn -- that erasure is the
// whole reason it cannot be modelled at 'no_lakes' severity. It sits BELOW 'failed' because a
// genuine outage is the more urgent of the two and is never masked by an indexing gap.
// The Record key type is load-bearing: adding an outcome to the Zod enum without ranking it here
// is a compile error, not a silent severity-0 default.
const OUTCOME_SEVERITY: Record<RetrievalSummary['outcome'], number> = {
  failed: 3,
  not_indexed: 2,
  ok: 1,
  no_lakes: 0,
};

/**
 * Merges two per-turn retrieval summaries (see RetrievalSummarySchema in promptMeta.ts).
 *
 * Extracted into its own module, with no heavy dependencies, so it can be called from the
 * tool-call merge path (ToolBuilder.applyQuestStatusChanges), the forced/lake-memory arm
 * (ChatCompletionFeatures), and the agent-mode run-scoped accumulator (agentExecutor) without any
 * of them importing ToolBuilder.ts itself, which pulls in ServerAgentStore, MCP tool generation
 * and llm-adapters purely for this function.
 *
 * - attempted: OR - once any surface attempted retrieval this turn, it stays true.
 * - outcome: worst-of by severity (failed > not_indexed > ok > no_lakes), so a single failure
 *   within a turn is never masked by a later success or abstain, an unsearchable corpus is never
 *   masked by a success on a different surface, and a real success is never masked by an abstain
 *   from a different surface in the same turn.
 * - surfaces / dataLakeTags: union, deduped.
 */
export function mergeRetrievalSummary(
  existing: RetrievalSummary | undefined,
  incoming: RetrievalSummary | undefined
): RetrievalSummary | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    attempted: existing.attempted || incoming.attempted,
    outcome:
      OUTCOME_SEVERITY[incoming.outcome] > OUTCOME_SEVERITY[existing.outcome] ? incoming.outcome : existing.outcome,
    surfaces: [...new Set([...existing.surfaces, ...incoming.surfaces])],
    dataLakeTags: [...new Set([...existing.dataLakeTags, ...incoming.dataLakeTags])],
  };
}
