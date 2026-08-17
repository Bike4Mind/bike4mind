/**
 * Build the user-facing reply for a run that stopped because it hit the iteration ceiling
 * (rather than the model signaling completion).
 *
 * On that path the extracted "final answer" is whatever the model happened to be mid-sentence
 * on -- often a trailed-off intent ("...let me close the loop on the third one now") that then
 * just stops. Surfacing that verbatim reads as a broken, useless response. Instead we wrap it in
 * a deterministic, honest notice: the run was truncated, here is the partial progress, and the
 * user can continue with a follow-up. Pure + side-effect-free so it is unit-testable. See #674.
 */
export function buildTruncatedRunReply(
  maxIterations: number,
  finalAnswer?: string,
  reason: 'iteration-limit' | 'credit-cap' = 'iteration-limit'
): string {
  const partial = finalAnswer?.trim();
  // 'credit-cap' omits the iteration count entirely rather than reporting the clamped
  // grace-grant size (e.g. 8) as if it were the run's real ceiling - see resolveDisplayAnswer.
  const header =
    reason === 'credit-cap'
      ? "This run stopped early because your organization's per-member credit cap was reached, so the result below is partial."
      : `This run reached its ${maxIterations}-iteration limit before finishing, so the result below is partial.`;
  const footer =
    reason === 'credit-cap'
      ? "A follow-up will hit the same cap, so it won't be able to continue this run."
      : 'Send a follow-up to continue from where this left off.';
  return partial ? `${header}\n\n${partial}\n\n${footer}` : `${header}\n\n${footer}`;
}

/**
 * Resolves the user-facing reply for a completed run, including cases
 * `buildTruncatedRunReply` alone can silently get wrong on a capped-out member's
 * one-iteration DAG-aggregation grace grant:
 * - `ReActAgent` always synthesizes a `final_answer` step before returning
 *   `reachedMaxIterations: true` (its own "I reached the maximum number of
 *   iterations..." notice, or genuine trailing content) - `finalAnswer` is
 *   therefore NEVER actually undefined on that path, so a plain `finalAnswer ??
 *   dagAggregationFallbackSummary` never reaches the fallback. On the credit-cap
 *   grace path specifically, `isOverCapGraceIteration` inverts that precedence:
 *   the summary is preferred, since the synthesized notice would also leak the
 *   clamped grant size (e.g. "8/8") as if it were the run's real ceiling.
 * - If the wake lands with the iteration loop unable to run at all (e.g.
 *   `iterationIndex` was already at or past `configuredMaxIterations`),
 *   `ranAnyIteration` is false and `finalAnswer` (if set) is read from an
 *   EARLIER iteration's checkpoint, not this wake's result - the just-built
 *   summary is the only fresh content this invocation actually produced.
 * - The generic "send a follow-up" footer is actively wrong on the credit-cap
 *   path: a follow-up creates a new execution that the same per-member cap gate
 *   immediately refuses. `isOverCapGraceIteration` selects the honest
 *   credit-cap message instead.
 * `configuredMaxIterations` must be the run's real ceiling, not a clamped one -
 * see `clampMaxIterationsForOverCapAggregationWake` in `agentExecutorDag.ts`.
 */
export function resolveDisplayAnswer(args: {
  reachedMaxIterations: boolean;
  ranAnyIteration: boolean;
  finalAnswer: string | undefined;
  dagAggregationFallbackSummary: string | undefined;
  configuredMaxIterations: number;
  isOverCapGraceIteration: boolean;
}): string | undefined {
  if (!args.ranAnyIteration && args.dagAggregationFallbackSummary !== undefined) {
    return args.dagAggregationFallbackSummary;
  }
  if (!args.reachedMaxIterations) return args.finalAnswer;
  // If neither exists, this still falls through to buildTruncatedRunReply's own
  // no-partial-content form (header + footer, no dropped middle section).
  const answer = args.isOverCapGraceIteration
    ? (args.dagAggregationFallbackSummary ?? args.finalAnswer)
    : (args.finalAnswer ?? args.dagAggregationFallbackSummary);
  return buildTruncatedRunReply(
    args.configuredMaxIterations,
    answer,
    args.isOverCapGraceIteration ? 'credit-cap' : 'iteration-limit'
  );
}
