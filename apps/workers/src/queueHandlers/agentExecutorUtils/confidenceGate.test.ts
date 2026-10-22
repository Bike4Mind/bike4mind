import { describe, it, expect, vi } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import {
  evaluateConfidenceGate,
  formatConfidenceGateReason,
  isPausingLowConfidenceStreak,
  recordAndDecideConfidencePause,
  type ConfidenceGateEvaluation,
  type ConfidenceGateInput,
} from './confidenceGate';

// Observation steps as ReActAgent emits them: `toolFailed` is the explicit failure
// flag, independent of the result text and of how the call was scored.
const observation = (confidence: number, toolFailed = false): AgentStep => ({
  type: 'observation',
  content: 'result',
  metadata: { timestamp: 0, toolName: 'some_tool', confidence, ...(toolFailed ? { toolFailed: true } : {}) },
});
const failed = () => observation(0.1, true);

const average = (steps: AgentStep[]) => steps.reduce((sum, s) => sum + (s.metadata?.confidence ?? 0), 0) / steps.length;

const input = (steps: AgentStep[], overrides: Partial<ConfidenceGateInput> = {}): ConfidenceGateInput => ({
  gate: { iteration: 2, confidence: average(steps) },
  isComplete: false,
  reachedMaxIterations: false,
  threshold: 0.6,
  iterationSteps: steps,
  ...overrides,
});

describe('evaluateConfidenceGate', () => {
  it('does not evaluate the gate when every tool call in the iteration failed', () => {
    expect(evaluateConfidenceGate(input([failed(), failed()]))).toBeNull();
  });

  it('leaves failed tool calls out of the confidence the gate decides on', () => {
    expect(evaluateConfidenceGate(input([failed(), observation(0.7)]))).toEqual({
      iteration: 2,
      confidence: 0.7,
      belowThreshold: false,
      pausable: true,
    });
  });

  it('still flags low confidence from calls that ran, alongside a failed one', () => {
    expect(evaluateConfidenceGate(input([failed(), observation(0.3)]))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: true,
    });
  });

  it('counts a low-scored result that did not fail (e.g. text starting with "Error:")', () => {
    const gate = evaluateConfidenceGate(input([observation(0.1), observation(0.7)]));
    expect(gate?.confidence).toBeCloseTo(0.4);
    expect(gate?.belowThreshold).toBe(true);
  });

  it("falls back to the agent's own confidence when the steps do not reproduce it", () => {
    const steps = [failed(), observation(0.7)];
    expect(evaluateConfidenceGate(input(steps, { gate: { iteration: 2, confidence: 0.25 } }))).toEqual({
      iteration: 2,
      confidence: 0.25,
      belowThreshold: true,
      pausable: true,
    });
    expect(evaluateConfidenceGate(input([], { gate: { iteration: 2, confidence: 0.25 } }))?.confidence).toBe(0.25);
  });

  it('evaluates but cannot pause a completed or iteration-capped run', () => {
    const steps = [observation(0.3)];
    expect(evaluateConfidenceGate(input(steps, { isComplete: true }))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: false,
    });
    expect(evaluateConfidenceGate(input(steps, { reachedMaxIterations: true }))?.pausable).toBe(false);
  });

  it('does not evaluate when no tools ran', () => {
    expect(evaluateConfidenceGate(input([observation(0.3)], { gate: null }))).toBeNull();
  });

  it('honors a threshold of 0 as a disabled gate', () => {
    expect(evaluateConfidenceGate(input([observation(0.3)], { threshold: 0 }))?.belowThreshold).toBe(false);
  });
});

describe('isPausingLowConfidenceStreak', () => {
  it('lets a single low iteration through and pauses from the second consecutive one', () => {
    expect(isPausingLowConfidenceStreak(0)).toBe(false);
    expect(isPausingLowConfidenceStreak(1)).toBe(false);
    expect(isPausingLowConfidenceStreak(2)).toBe(true);
    expect(isPausingLowConfidenceStreak(3)).toBe(true);
  });
});

describe('formatConfidenceGateReason', () => {
  it('names the confidence, the threshold and the streak length', () => {
    expect(formatConfidenceGateReason(0.3, 0.6, 2)).toBe(
      '2 iterations in a row below the 60% confidence threshold (latest 30%)'
    );
  });
});

describe('recordAndDecideConfidencePause', () => {
  const evaluation = (overrides: Partial<ConfidenceGateEvaluation> = {}): ConfidenceGateEvaluation => ({
    iteration: 2,
    confidence: 0.3,
    belowThreshold: true,
    pausable: true,
    ...overrides,
  });

  it('records whether the iteration was below the threshold, not whether it can pause', async () => {
    const record = vi.fn(async () => 1);
    await recordAndDecideConfidencePause(evaluation({ belowThreshold: false, pausable: true }), record);
    expect(record).toHaveBeenCalledWith(0.3, { belowThreshold: false });
  });

  it('does not pause on the first low iteration and pauses on the second', async () => {
    expect(
      await recordAndDecideConfidencePause(
        evaluation(),
        vi.fn(async () => 1)
      )
    ).toEqual({
      pause: false,
      lowConfidenceStreak: 1,
    });
    expect(
      await recordAndDecideConfidencePause(
        evaluation(),
        vi.fn(async () => 2)
      )
    ).toEqual({
      pause: true,
      lowConfidenceStreak: 2,
    });
  });

  it('does not pause a completed run even on a streak', async () => {
    const decision = await recordAndDecideConfidencePause(
      evaluation({ pausable: false }),
      vi.fn(async () => 2)
    );
    expect(decision.pause).toBe(false);
  });
});
