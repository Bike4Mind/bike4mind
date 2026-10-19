import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { evaluateConfidenceGate, type ConfidenceGateInput } from './confidenceGate';

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
      pause: false,
    });
  });

  it('still pauses on low confidence from calls that ran, alongside a failed one', () => {
    expect(evaluateConfidenceGate(input([failed(), observation(0.3)]))).toEqual({
      iteration: 2,
      confidence: 0.3,
      pause: true,
    });
  });

  it('counts a low-scored result that did not fail (e.g. text starting with "Error:")', () => {
    const gate = evaluateConfidenceGate(input([observation(0.1), observation(0.7)]));
    expect(gate?.confidence).toBeCloseTo(0.4);
    expect(gate?.pause).toBe(true);
  });

  it("falls back to the agent's own confidence when the steps do not reproduce it", () => {
    const steps = [failed(), observation(0.7)];
    expect(evaluateConfidenceGate(input(steps, { gate: { iteration: 2, confidence: 0.25 } }))).toEqual({
      iteration: 2,
      confidence: 0.25,
      pause: true,
    });
    expect(evaluateConfidenceGate(input([], { gate: { iteration: 2, confidence: 0.25 } }))?.confidence).toBe(0.25);
  });

  it('evaluates but does not pause a completed or iteration-capped run', () => {
    const steps = [observation(0.3)];
    expect(evaluateConfidenceGate(input(steps, { isComplete: true }))).toEqual({
      iteration: 2,
      confidence: 0.3,
      pause: false,
    });
    expect(evaluateConfidenceGate(input(steps, { reachedMaxIterations: true }))?.pause).toBe(false);
  });

  it('does not evaluate when no tools ran', () => {
    expect(evaluateConfidenceGate(input([observation(0.3)], { gate: null }))).toBeNull();
  });

  it('honors a threshold of 0 as a disabled gate', () => {
    expect(evaluateConfidenceGate(input([observation(0.3)], { threshold: 0 }))?.pause).toBe(false);
  });
});
