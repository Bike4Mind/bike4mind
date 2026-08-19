import type { PromptMeta } from '@bike4mind/common';

export type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

const OUTCOME_SEVERITY: Record<RetrievalSummary['outcome'], number> = {
  failed: 2,
  no_lakes: 1,
  ok: 0,
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
 * - outcome: worst-of by severity (failed > no_lakes > ok), so a single failure within a turn is
 *   never masked by a later success.
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
