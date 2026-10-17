import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { resolveConfidenceGatePause, type ConfidenceGateInput } from './confidenceGate';

// Mirrors ReActAgent.scoreToolResult: "Error:" observations score 0.1 with a
// deterministic source, empty ones 0.3, everything else 0.7.
const observation = (content: string): AgentStep => ({
  type: 'observation',
  content,
  metadata: {
    timestamp: 0,
    toolName: 'some_tool',
    confidence: content.startsWith('Error:') ? 0.1 : content.trim() ? 0.7 : 0.3,
    confidenceSource: content.startsWith('Error:') ? 'deterministic' : 'default',
  },
});

const average = (steps: AgentStep[]) => steps.reduce((sum, s) => sum + (s.metadata?.confidence ?? 0), 0) / steps.length;

const input = (steps: AgentStep[], overrides: Partial<ConfidenceGateInput> = {}): ConfidenceGateInput => ({
  gate: { iteration: 1, confidence: average(steps) },
  isComplete: false,
  reachedMaxIterations: false,
  threshold: 0.6,
  iterationSteps: steps,
  ...overrides,
});

describe('resolveConfidenceGatePause', () => {
  it('does not pause when every tool call in the iteration failed', () => {
    const steps = [observation('Error: Resource "GenerationJobQueue" is not linked')];
    expect(resolveConfidenceGatePause(input(steps))).toBeNull();
  });

  it('does not pause when a tool error is the only thing dragging confidence down', () => {
    const steps = [observation('Error: queue unavailable'), observation('{"ok":true}')];
    expect(resolveConfidenceGatePause(input(steps))).toBeNull();
  });

  it('still pauses on low confidence from non-error results alongside a tool error', () => {
    const steps = [observation('Error: queue unavailable'), observation('   ')];
    expect(resolveConfidenceGatePause(input(steps))).toEqual({ confidence: 0.3 });
  });

  it('pauses on low confidence when no tool errored', () => {
    const steps = [observation(''), observation('')];
    expect(resolveConfidenceGatePause(input(steps))).toEqual({ confidence: 0.3 });
  });

  it('does not pause when confidence clears the threshold', () => {
    expect(resolveConfidenceGatePause(input([observation('result')]))).toBeNull();
  });

  it('does not pause when the gate was not evaluated or the run is ending', () => {
    const steps = [observation('')];
    expect(resolveConfidenceGatePause(input(steps, { gate: null }))).toBeNull();
    expect(resolveConfidenceGatePause(input(steps, { isComplete: true }))).toBeNull();
    expect(resolveConfidenceGatePause(input(steps, { reachedMaxIterations: true }))).toBeNull();
  });

  it('honors a threshold of 0 as a disabled gate', () => {
    expect(resolveConfidenceGatePause(input([observation('')], { threshold: 0 }))).toBeNull();
  });
});
