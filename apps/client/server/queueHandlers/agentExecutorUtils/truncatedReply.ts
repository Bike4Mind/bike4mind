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
export function buildTruncatedRunReply(maxIterations: number, finalAnswer?: string): string {
  const partial = finalAnswer?.trim();
  const header = `This run reached its ${maxIterations}-iteration limit before finishing, so the result below is partial.`;
  const footer = 'Send a follow-up to continue from where this left off.';
  return partial ? `${header}\n\n${partial}\n\n${footer}` : `${header}\n\n${footer}`;
}

/**
 * Resolves the user-facing reply for a completed run, including the one case
 * `buildTruncatedRunReply` alone can silently get wrong: a capped-out member's
 * one-iteration DAG-aggregation grace grant that hits its own ceiling without
 * producing a `final_answer` step. Without the `dagAggregationFallbackSummary`
 * fallback, that path would report the truncation notice with nothing behind it,
 * dropping the already-paid-for child work this exemption exists to return.
 * `configuredMaxIterations` must be the run's real ceiling, not a clamped one -
 * see `clampMaxIterationsForOverCapAggregationWake` in `agentExecutorDag.ts`.
 */
export function resolveDisplayAnswer(args: {
  reachedMaxIterations: boolean;
  finalAnswer: string | undefined;
  dagAggregationFallbackSummary: string | undefined;
  configuredMaxIterations: number;
}): string | undefined {
  if (!args.reachedMaxIterations) return args.finalAnswer;
  return buildTruncatedRunReply(args.configuredMaxIterations, args.finalAnswer ?? args.dagAggregationFallbackSummary);
}
