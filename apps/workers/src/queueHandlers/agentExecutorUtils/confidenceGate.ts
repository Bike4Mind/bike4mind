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
  /** The execution's scripted scores (`IAgentExecution.confidenceOverrides`); see `confidenceOverrideFor`. */
  confidenceOverrides?: readonly number[];
}

export interface ConfidenceGateEvaluation {
  /** Agent-reported (1-indexed) iteration. */
  iteration: number;
  /** The confidence the decision was made on; record this as telemetry unless `overridden`. */
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
  confidenceOverrides,
}: ConfidenceGateInput): ConfidenceGateEvaluation | null {
  if (gate === null) return null;

  const scored = scoredConfidence(gate.confidence, iterationSteps);
  if (scored === null) return null;

  const override = confidenceOverrideFor(confidenceOverrides, gate.iteration);
  const confidence = override ?? scored;
  return {
    iteration: gate.iteration,
    confidence,
    belowThreshold: confidence < threshold,
    pausable: !isComplete && !reachedMaxIterations,
    overridden: override !== undefined,
  };
}

/** The agent's iteration average with failed calls left out, or null when every call failed. */
function scoredConfidence(agentConfidence: number, iterationSteps: AgentStep[]): number | null {
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
  const stepsMatchGate = count > 0 && Math.abs(total / count - agentConfidence) < 1e-9;
  if (!stepsMatchGate || scoredCount === count) return agentConfidence;
  return scoredCount === 0 ? null : scoredTotal / scoredCount;
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
