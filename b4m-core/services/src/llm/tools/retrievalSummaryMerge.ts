import type { PromptMeta } from '@bike4mind/common';

export type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

// 'ok' outranks 'no_lakes': a turn where one surface abstained (no lakes in scope) while another
// surface actually retrieved successfully is reachable (e.g. LakeMemoryFeature abstains but
// search_knowledge_base succeeds independently), and the merged outcome must reflect the success,
// not the abstain. 'failed' still outranks both -- a genuine failure on any surface is never
// masked by a success or an abstain elsewhere in the same turn.
const OUTCOME_SEVERITY: Record<NonNullable<RetrievalSummary['outcome']>, number> = {
  failed: 2,
  ok: 1,
  no_lakes: 0,
};

/**
 * An absent outcome (the seeded not-attempted turn) ranks below every real one, so seeding a turn
 * can never erase the outcome a surface later reports - in either merge order.
 */
function outcomeSeverity(outcome: RetrievalSummary['outcome']): number {
  return outcome === undefined ? -1 : OUTCOME_SEVERITY[outcome];
}

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
 * - outcome: worst-of by severity (failed > ok > no_lakes > absent), so a single failure within a
 *   turn is never masked by a later success or abstain, and a real success is never masked by an
 *   abstain from a different surface in the same turn.
 * - mode: 'forced' wins. It is a property of the TURN, not of the surface that happened to write
 *   it, and only the forced arm and the seed ever assert it - so a tool-arm write carrying
 *   'optional' must not downgrade a turn the forced arm already claimed. Order-independent.
 * - forcedSkipReason: first defined survives. The forced arm takes exactly one skip per turn, so
 *   a second value would mean two arms disagreeing about the same fact; keeping the earlier one
 *   makes the merge order-independent rather than last-writer-wins.
 * - surfaces / dataLakeTags: union, deduped.
 */
export function mergeRetrievalSummary(
  existing: RetrievalSummary | undefined,
  incoming: RetrievalSummary | undefined
): RetrievalSummary | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const outcome =
    outcomeSeverity(incoming.outcome) > outcomeSeverity(existing.outcome) ? incoming.outcome : existing.outcome;
  const mode = existing.mode === 'forced' || incoming.mode === 'forced' ? 'forced' : (existing.mode ?? incoming.mode);
  const forcedSkipReason = existing.forcedSkipReason ?? incoming.forcedSkipReason;

  // Keys are spread in only when defined: the shape is absent-or-fully-present on the Mongoose
  // side, and an explicit `undefined` would persist as a set-but-empty path.
  return {
    attempted: existing.attempted || incoming.attempted,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(forcedSkipReason !== undefined ? { forcedSkipReason } : {}),
    surfaces: [...new Set([...existing.surfaces, ...incoming.surfaces])],
    dataLakeTags: [...new Set([...existing.dataLakeTags, ...incoming.dataLakeTags])],
  };
}
