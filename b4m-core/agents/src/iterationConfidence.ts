export type ScoredToolCall = {
  confidence: number;
  /** The call threw or could not run (ReActAgent's `toolFailed`). */
  toolFailed?: boolean;
};

/**
 * The confidence one iteration's tool calls give the confidence gate: the strongest
 * score among calls that ran, or null when every call failed (or none ran).
 *
 * The strongest score, not the mean, because the gate asks whether the iteration
 * produced any usable evidence. One empty search beside a good result leaves the
 * model with something to work from; averaging them (0.3 and 0.7 make 0.5) would
 * pause the run anyway. So the iteration is below threshold only when every call
 * that ran is. Failed calls never count: the model sees the error and can recover,
 * while a human answering the gate cannot fix a broken tool.
 *
 * Shared by both sites that decide the gate so they cannot drift: the web executor's
 * per-iteration gate (`evaluateConfidenceGate` in apps/workers) and the approval-replay
 * gate (`ReActAgent.takeIterationConfidence`). The raw average `ReActAgent` passes to
 * `options.confidenceGate` is not this rule.
 */
export function usableEvidenceConfidence(calls: readonly ScoredToolCall[]): number | null {
  let strongest: number | null = null;
  for (const call of calls) {
    if (call.toolFailed) continue;
    if (strongest === null || call.confidence > strongest) strongest = call.confidence;
  }
  return strongest;
}
