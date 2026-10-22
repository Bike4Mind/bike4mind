import type { AgentStep } from '@bike4mind/agents';

/**
 * Consecutive low-confidence iterations before the gate pauses. One weak tool result
 * is often recovered on the next iteration with no human involved; a run that stays
 * low is the stuck loop the gate exists to catch.
 */
export const LOW_CONFIDENCE_STREAK_TO_PAUSE = 2;

export interface ConfidenceGateInput {
  /** Iteration-average confidence the agent reported, or null when no tools ran. */
  gate: { iteration: number; confidence: number } | null;
  isComplete: boolean;
  reachedMaxIterations: boolean;
  threshold: number;
  /** `IterationResult.allSteps` for the iteration being evaluated. */
  iterationSteps: AgentStep[];
}

export interface ConfidenceGateEvaluation {
  /** Agent-reported (1-indexed) iteration. */
  iteration: number;
  /** The confidence the decision was made on; record this as telemetry. */
  confidence: number;
  /** Advances the persisted low-confidence streak when true, resets it when false. */
  belowThreshold: boolean;
  /** False for a completed or iteration-capped run, which has nothing left to pause. */
  pausable: boolean;
}

/**
 * Evaluate the confidence gate for one iteration. Returns null when the gate has
 * nothing to evaluate: no tools ran, or every tool call failed.
 *
 * Failed tool calls (`metadata.toolFailed`, set by ReActAgent only where a call
 * threw or could not run) are left out of the average. The model already sees the
 * error and can retry, switch tools, or report it, while a human answering the
 * gate cannot fix a broken tool - pausing on one only parks the run in `paused`,
 * which counts against the per-user concurrency cap.
 */
export function evaluateConfidenceGate({
  gate,
  isComplete,
  reachedMaxIterations,
  threshold,
  iterationSteps,
}: ConfidenceGateInput): ConfidenceGateEvaluation | null {
  if (gate === null) return null;

  let total = 0;
  let count = 0;
  let scoredTotal = 0;
  let scoredCount = 0;
  for (const step of iterationSteps) {
    if (step.type !== 'observation') continue;
    const confidence = step.metadata?.confidence ?? 0;
    total += confidence;
    count++;
    if (!step.metadata?.toolFailed) {
      scoredTotal += confidence;
      scoredCount++;
    }
  }

  // The agent averages its own per-call scores, which can include observations
  // outside `allSteps` (e.g. a checkpoint restored mid-iteration). Only re-derive
  // the value when the steps reproduce the agent's average; otherwise keep it.
  const stepsMatchGate = count > 0 && Math.abs(total / count - gate.confidence) < 1e-9;
  let confidence = gate.confidence;
  if (stepsMatchGate && scoredCount < count) {
    if (scoredCount === 0) return null;
    confidence = scoredTotal / scoredCount;
  }

  return {
    iteration: gate.iteration,
    confidence,
    belowThreshold: confidence < threshold,
    pausable: !isComplete && !reachedMaxIterations,
  };
}

/** Whether a low-confidence streak (as returned by `recordIterationConfidence`) pauses the run. */
export function isPausingLowConfidenceStreak(lowConfidenceStreak: number): boolean {
  return lowConfidenceStreak >= LOW_CONFIDENCE_STREAK_TO_PAUSE;
}

/**
 * Persist one evaluated iteration (telemetry + streak, in one write) and decide whether
 * it pauses the run. Iterations the gate skipped (`evaluateConfidenceGate` returned null)
 * never reach here, so they neither extend nor break the streak.
 */
export async function recordAndDecideConfidencePause(
  evaluation: ConfidenceGateEvaluation,
  recordIterationConfidence: (confidence: number, options: { belowThreshold: boolean }) => Promise<number>
): Promise<{ pause: boolean; lowConfidenceStreak: number }> {
  const lowConfidenceStreak = await recordIterationConfidence(evaluation.confidence, {
    belowThreshold: evaluation.belowThreshold,
  });
  return { pause: evaluation.pausable && isPausingLowConfidenceStreak(lowConfidenceStreak), lowConfidenceStreak };
}

/** The human-facing `pendingGate.reason`, shared by the per-iteration and replay gate sites. */
export function formatConfidenceGateReason(confidence: number, threshold: number, lowConfidenceStreak: number): string {
  return `Iteration confidence ${(confidence * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}% for ${lowConfidenceStreak} scored iterations in a row`;
}
