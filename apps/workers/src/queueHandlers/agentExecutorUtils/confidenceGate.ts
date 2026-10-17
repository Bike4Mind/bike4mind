import type { AgentStep } from '@bike4mind/agents';

export interface ConfidenceGateInput {
  /** Iteration-average confidence the agent reported, or null when no tools ran. */
  gate: { iteration: number; confidence: number } | null;
  isComplete: boolean;
  reachedMaxIterations: boolean;
  threshold: number;
  /** `IterationResult.allSteps` for the iteration being evaluated. */
  iterationSteps: AgentStep[];
}

/**
 * Decide whether an iteration should pause the run at the confidence gate.
 * Returns the confidence to report on the pause, or null to keep running.
 *
 * Failed tool calls (scored `confidenceSource: 'deterministic'` by
 * ReActAgent.buildObservationStep) are left out of the average. The model already
 * sees the error as its observation and can retry, switch tools, or report it,
 * while a human answering the gate cannot fix a broken tool - pausing on one only
 * parks the run in `paused`, which counts against the per-user concurrency cap.
 */
export function resolveConfidenceGatePause({
  gate,
  isComplete,
  reachedMaxIterations,
  threshold,
  iterationSteps,
}: ConfidenceGateInput): { confidence: number } | null {
  if (gate === null || isComplete || reachedMaxIterations) return null;

  const observations = iterationSteps.filter(s => s.type === 'observation');
  const scored = observations.filter(s => s.metadata?.confidenceSource !== 'deterministic');
  let confidence = gate.confidence;
  if (scored.length < observations.length) {
    if (scored.length === 0) return null;
    confidence = scored.reduce((sum, s) => sum + (s.metadata?.confidence ?? 0), 0) / scored.length;
  }
  return confidence < threshold ? { confidence } : null;
}
