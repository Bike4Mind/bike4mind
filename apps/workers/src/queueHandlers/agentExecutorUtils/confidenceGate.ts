import { usableEvidenceConfidence, type AgentStep, type ScoredToolCall } from '@bike4mind/agents';

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
  /** The execution's scripted scores (`IAgentExecution.confidenceOverrides`); see `confidenceOverrideFor`. */
  confidenceOverrides?: readonly number[];
}

export interface ConfidenceGateEvaluation {
  /** Agent-reported (1-indexed) iteration. */
  iteration: number;
  /** The confidence the decision was made on (see `usableEvidenceConfidence`); record as telemetry unless `overridden`. */
  confidence: number;
  /** Advances the persisted low-confidence streak when true, resets it when false. */
  belowThreshold: boolean;
  /** False for a completed or iteration-capped run, which has nothing left to pause. */
  pausable: boolean;
  /** True when `confidence` is a scripted override rather than a real signal. */
  overridden: boolean;
}

/**
 * The scripted score for the agent's 1-indexed `iteration`: entry `i` scores iteration `i + 1`,
 * and undefined (keep the real score) when the run has no script or the script is shorter.
 *
 * Shared by both gate sites - `evaluateConfidenceGate` and `gateReplayConfidence` - so the two
 * cannot index the script differently. Each applies it only to an iteration it would evaluate
 * anyway: a script replaces a score, it never makes the gate evaluate a skipped iteration.
 */
export function confidenceOverrideFor(overrides: readonly number[] | undefined, iteration: number): number | undefined {
  return overrides?.[iteration - 1];
}

/**
 * Evaluate the confidence gate for one iteration. Returns null when the gate has
 * nothing to evaluate: no tools ran, or every tool call failed.
 *
 * The iteration is below threshold only when it produced no usable evidence: every
 * call that ran scored below it (`usableEvidenceConfidence`). Failed tool calls
 * (`metadata.toolFailed`) never count - a human answering the gate cannot fix a
 * broken tool, and pausing on one only parks the run in `paused`, which counts
 * against the per-user concurrency cap.
 */
export function evaluateConfidenceGate({
  gate,
  isComplete,
  reachedMaxIterations,
  threshold,
  iterationSteps,
  confidenceOverrides,
}: ConfidenceGateInput): ConfidenceGateEvaluation | null {
  if (gate === null) return null;

  const calls: ScoredToolCall[] = [];
  for (const step of iterationSteps) {
    if (step.type !== 'observation') continue;
    calls.push({ confidence: step.metadata?.confidence ?? 0, toolFailed: step.metadata?.toolFailed });
  }

  // `gate.confidence` is the agent's mean over every call it scored this iteration. When the
  // steps reproduce that mean they cover the iteration; the else arm below is defensive only.
  const allCallsMean = calls.reduce((sum, call) => sum + call.confidence, 0) / calls.length;
  const stepsCoverIteration = calls.length > 0 && Math.abs(allCallsMean - gate.confidence) < 1e-9;
  const visibleEvidence = usableEvidenceConfidence(calls);
  let evidenceConfidence: number;
  if (stepsCoverIteration) {
    if (visibleEvidence === null) return null;
    evidenceConfidence = visibleEvidence;
  } else {
    // Partial view: a visible good call still proves usable evidence, and a mean at or
    // above threshold implies some call was; otherwise keep the agent's own value.
    evidenceConfidence = Math.max(gate.confidence, visibleEvidence ?? 0);
  }

  const override = confidenceOverrideFor(confidenceOverrides, gate.iteration);
  const confidence = override ?? evidenceConfidence;
  return {
    iteration: gate.iteration,
    confidence,
    belowThreshold: confidence < threshold,
    pausable: !isComplete && !reachedMaxIterations,
    overridden: override !== undefined,
  };
}

/** Whether a low-confidence streak (as returned by `recordIterationConfidence`) pauses the run. */
export function isPausingLowConfidenceStreak(lowConfidenceStreak: number): boolean {
  return lowConfidenceStreak >= LOW_CONFIDENCE_STREAK_TO_PAUSE;
}

/** `AgentExecutionRepository.recordIterationConfidence` bound to one execution; returns the updated streak. */
export type RecordIterationConfidence = (
  confidence: number,
  options: { belowThreshold: boolean; recordTelemetry: boolean }
) => Promise<number>;

/**
 * Persist one evaluated iteration (telemetry + streak, in one write) and decide whether
 * it pauses the run. Iterations the gate skipped (`evaluateConfidenceGate` returned null)
 * never reach here, so they neither extend nor break the streak. A scripted (`overridden`)
 * score advances the streak like a real one but stays out of the telemetry counters.
 */
export async function recordAndDecideConfidencePause(
  evaluation: ConfidenceGateEvaluation,
  recordIterationConfidence: RecordIterationConfidence
): Promise<{ pause: boolean; lowConfidenceStreak: number }> {
  const lowConfidenceStreak = await recordIterationConfidence(evaluation.confidence, {
    belowThreshold: evaluation.belowThreshold,
    recordTelemetry: !evaluation.overridden,
  });
  return { pause: evaluation.pausable && isPausingLowConfidenceStreak(lowConfidenceStreak), lowConfidenceStreak };
}

/** Per-iteration gate site: a skipped iteration (null evaluation) is not recorded, so it neither extends nor breaks the streak. */
export async function decideIterationConfidencePause(
  evaluation: ConfidenceGateEvaluation | null,
  recordIterationConfidence: RecordIterationConfidence
): Promise<{ pause: boolean; lowConfidenceStreak: number } | null> {
  return evaluation === null ? null : recordAndDecideConfidencePause(evaluation, recordIterationConfidence);
}

/** The human-facing `pendingGate.reason`, shared by the per-iteration and replay gate sites. */
export function formatConfidenceGateReason(confidence: number, threshold: number, lowConfidenceStreak: number): string {
  const pct = (value: number) => (value * 100).toFixed(0);
  const below = `below the ${pct(threshold)}% confidence threshold`;
  return `${lowConfidenceStreak} iterations in a row ${below} (latest ${pct(confidence)}%)`;
}
