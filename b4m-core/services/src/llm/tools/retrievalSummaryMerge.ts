import type { PromptMeta } from '@bike4mind/common';

export type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

// 'ok' outranks 'no_lakes': a turn where one surface abstained (no lakes in scope) while another
// surface actually retrieved successfully is reachable (e.g. LakeMemoryFeature abstains but
// search_knowledge_base succeeds independently), and the merged outcome must reflect the success,
// not the abstain. 'failed' still outranks both -- a genuine failure on any surface is never
// masked by a success or an abstain elsewhere in the same turn.
const OUTCOME_SEVERITY: Record<RetrievalSummary['outcome'], number> = {
  failed: 2,
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
 * - outcome: worst-of by severity (failed > ok > no_lakes), so a single failure within a turn is
 *   never masked by a later success or abstain, and a real success is never masked by an abstain
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
