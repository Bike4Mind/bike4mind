export type AggregationGraceReason = 'credit-cap' | 'model-unavailable' | 'model-configuration-unavailable';

/** Explain an artificial aggregation ceiling without suggesting a follow-up that admission refuses. */
export function buildTruncatedRunReply(
  maxIterations: number,
  finalAnswer?: string,
  reason: 'iteration-limit' | AggregationGraceReason = 'iteration-limit'
): string {
  const partial = finalAnswer?.trim();
  const notices = {
    'credit-cap': {
      header:
        "This run stopped early because your organization's per-member credit cap was reached, so the result below is partial.",
      footer: "A follow-up will hit the same cap, so it won't be able to continue this run.",
    },
    'model-configuration-unavailable': {
      header: 'This run stopped early because model configuration could not be loaded, so the result below is partial.',
      footer: 'Please retry when model configuration is available.',
    },
    'model-unavailable': {
      header: 'This run stopped early because its model is no longer available to you, so the result below is partial.',
      footer: 'Choose an available model before starting another run.',
    },
    'iteration-limit': {
      header: `This run reached its ${maxIterations}-iteration limit before finishing, so the result below is partial.`,
      footer: 'Send a follow-up to continue from where this left off.',
    },
  };
  const { header, footer } = notices[reason];
  return partial ? `${header}\n\n${partial}\n\n${footer}` : `${header}\n\n${footer}`;
}

export function resolveDisplayAnswer(args: {
  reachedMaxIterations: boolean;
  ranAnyIteration: boolean;
  finalAnswer: string | undefined;
  dagAggregationFallbackSummary: string | undefined;
  // Use the real ceiling, before clampMaxIterationsForOverCapAggregationWake lowers the wake budget.
  configuredMaxIterations: number;
  aggregationGraceReason: AggregationGraceReason | undefined;
}): string | undefined {
  // Without an iteration the checkpoint answer is stale; only the fresh child report belongs to this wake.
  if (!args.ranAnyIteration && args.dagAggregationFallbackSummary !== undefined) {
    return args.dagAggregationFallbackSummary;
  }
  if (!args.reachedMaxIterations) return args.finalAnswer;
  // ReActAgent synthesizes a final_answer at the artificial ceiling. Prefer the paid child report.
  const answer = args.aggregationGraceReason
    ? (args.dagAggregationFallbackSummary ?? args.finalAnswer)
    : (args.finalAnswer ?? args.dagAggregationFallbackSummary);
  return buildTruncatedRunReply(args.configuredMaxIterations, answer, args.aggregationGraceReason ?? 'iteration-limit');
}
