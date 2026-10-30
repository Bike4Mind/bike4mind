import { describe, it, expect, vi } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import {
  decideIterationConfidencePause,
  evaluateConfidenceGate,
  formatConfidenceGateReason,
  isPausingLowConfidenceStreak,
  LOW_CONFIDENCE_STREAK_TO_PAUSE,
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
      overridden: false,
    });
  });

  it('still flags low confidence from calls that ran, alongside a failed one', () => {
    expect(evaluateConfidenceGate(input([failed(), observation(0.3)]))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: true,
      overridden: false,
    });
  });

  it('does not flag a mixed iteration: one empty result beside a usable one', () => {
    // The mean (0.5) would be below 0.6; the usable 0.7 result is what the gate decides on.
    expect(evaluateConfidenceGate(input([observation(0.3), observation(0.7)]))).toEqual({
      iteration: 2,
      confidence: 0.7,
      belowThreshold: false,
      pausable: true,
      overridden: false,
    });
    expect(evaluateConfidenceGate(input([observation(0.3), observation(0.3), observation(0.7)]))?.belowThreshold).toBe(
      false
    );
  });

  it('flags an iteration where every call that ran came back empty', () => {
    expect(evaluateConfidenceGate(input([observation(0.3), observation(0.3)]))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: true,
      overridden: false,
    });
  });

  it('counts a low-scored result that did not fail (e.g. text starting with "Error:")', () => {
    const gate = evaluateConfidenceGate(input([observation(0.1), observation(0.3)]));
    expect(gate?.confidence).toBe(0.3);
    expect(gate?.belowThreshold).toBe(true);
  });

  it("falls back to the agent's own confidence when the steps do not reproduce it", () => {
    const steps = [failed(), observation(0.3)];
    expect(evaluateConfidenceGate(input(steps, { gate: { iteration: 2, confidence: 0.25 } }))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: true,
      overridden: false,
    });
    expect(evaluateConfidenceGate(input([], { gate: { iteration: 2, confidence: 0.25 } }))?.confidence).toBe(0.25);
    expect(evaluateConfidenceGate(input([failed()], { gate: { iteration: 2, confidence: 0.25 } }))?.confidence).toBe(
      0.25
    );
  });

  it('trusts a visible usable result even when the steps do not cover the whole iteration', () => {
    const steps = [failed(), observation(0.7)];
    expect(evaluateConfidenceGate(input(steps, { gate: { iteration: 2, confidence: 0.25 } }))?.belowThreshold).toBe(
      false
    );
  });

  it('evaluates but cannot pause a completed or iteration-capped run', () => {
    const steps = [observation(0.3)];
    expect(evaluateConfidenceGate(input(steps, { isComplete: true }))).toEqual({
      iteration: 2,
      confidence: 0.3,
      belowThreshold: true,
      pausable: false,
      overridden: false,
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
    overridden: false,
    ...overrides,
  });

  it('records whether the iteration was below the threshold, not whether it can pause', async () => {
    const record = vi.fn(async () => 1);
    await recordAndDecideConfidencePause(evaluation({ belowThreshold: false, pausable: true }), record);
    expect(record).toHaveBeenCalledWith(0.3, { belowThreshold: false, recordTelemetry: true });
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

describe('decideIterationConfidencePause', () => {
  const evaluation = (overrides: Partial<ConfidenceGateEvaluation> = {}): ConfidenceGateEvaluation => ({
    iteration: 2,
    confidence: 0.3,
    belowThreshold: true,
    pausable: true,
    overridden: false,
    ...overrides,
  });

  it('a single low iteration does not pause', async () => {
    const record = vi.fn(async () => 1);
    const low = evaluation({ belowThreshold: true, pausable: true });
    expect(await decideIterationConfidencePause(low, record)).toEqual({ pause: false, lowConfidenceStreak: 1 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(low.confidence, { belowThreshold: true, recordTelemetry: true });
  });

  it('a gate-skipped iteration leaves the streak alone', async () => {
    const record = vi.fn(async () => 5);
    expect(await decideIterationConfidencePause(null, record)).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  describe('scripted confidenceOverrides', () => {
    it('replaces a high real score with the entry for this 1-indexed iteration', () => {
      // Iteration 2 reads entry 1.
      expect(evaluateConfidenceGate(input([observation(0.9)], { confidenceOverrides: [0.95, 0.1] }))).toEqual({
        iteration: 2,
        confidence: 0.1,
        belowThreshold: true,
        pausable: true,
        overridden: true,
      });
    });

    it('replaces mixed usable evidence and excludes the scripted score from telemetry', async () => {
      const record = vi.fn(async () => LOW_CONFIDENCE_STREAK_TO_PAUSE);
      const gate = evaluateConfidenceGate(
        input([observation(0.3), observation(0.7)], { confidenceOverrides: [0.95, 0.1] })
      );

      expect(gate).toEqual({
        iteration: 2,
        confidence: 0.1,
        belowThreshold: true,
        pausable: true,
        overridden: true,
      });
      expect(await decideIterationConfidencePause(gate, record)).toEqual({
        pause: true,
        lowConfidenceStreak: LOW_CONFIDENCE_STREAK_TO_PAUSE,
      });
      expect(record).toHaveBeenCalledWith(0.1, { belowThreshold: true, recordTelemetry: false });
    });

    it('can force a pass over a low real score', () => {
      const gate = evaluateConfidenceGate(input([observation(0.1)], { confidenceOverrides: [0, 0.9] }));
      expect(gate).toMatchObject({ confidence: 0.9, belowThreshold: false, overridden: true });
    });

    it('falls back to the real score past the end of the script', () => {
      const gate = evaluateConfidenceGate(input([observation(0.3)], { confidenceOverrides: [0.9] }));
      expect(gate).toMatchObject({ confidence: 0.3, belowThreshold: true, overridden: false });
    });

    it('replaces the failed-call-adjusted score too', () => {
      const gate = evaluateConfidenceGate(input([failed(), observation(0.9)], { confidenceOverrides: [0, 0.2] }));
      expect(gate).toMatchObject({ confidence: 0.2, belowThreshold: true, overridden: true });
    });

    it('never makes the gate evaluate an iteration it would skip', () => {
      expect(evaluateConfidenceGate(input([], { gate: null, confidenceOverrides: [0.1, 0.1] }))).toBeNull();
      expect(evaluateConfidenceGate(input([failed(), failed()], { confidenceOverrides: [0.1, 0.1] }))).toBeNull();
    });

    it('never pauses a completed or iteration-capped run, whatever the script says', () => {
      const steps = [observation(0.9)];
      expect(evaluateConfidenceGate(input(steps, { isComplete: true, confidenceOverrides: [0, 0] }))?.pausable).toBe(
        false
      );
      expect(
        evaluateConfidenceGate(input(steps, { reachedMaxIterations: true, confidenceOverrides: [0, 0] }))?.pausable
      ).toBe(false);
    });

    it('records a scripted score into the streak but not the telemetry counters', async () => {
      const record = vi.fn(async () => 1);
      const scripted = evaluateConfidenceGate(input([observation(0.9)], { confidenceOverrides: [0.1, 0.1] }));
      await decideIterationConfidencePause(scripted, record);
      expect(record).toHaveBeenCalledWith(0.1, { belowThreshold: true, recordTelemetry: false });
    });

    it('fires the gate only once the script reaches a streak of low scores', async () => {
      // Stands in for the persisted streak: incremented below threshold, reset otherwise.
      let streak = 0;
      const record = vi.fn(async (_confidence: number, { belowThreshold }: { belowThreshold: boolean }) => {
        streak = belowThreshold ? streak + 1 : 0;
        return streak;
      });
      const script = Array.from({ length: LOW_CONFIDENCE_STREAK_TO_PAUSE }, () => 0.1);
      const pauses: boolean[] = [];
      for (let iteration = 1; iteration <= script.length; iteration++) {
        const gate = evaluateConfidenceGate(
          input([observation(0.9)], { gate: { iteration, confidence: 0.9 }, confidenceOverrides: script })
        );
        pauses.push((await decideIterationConfidencePause(gate, record))?.pause ?? false);
      }
      expect(pauses).toEqual([...Array(script.length - 1).fill(false), true]);
    });
  });
});
