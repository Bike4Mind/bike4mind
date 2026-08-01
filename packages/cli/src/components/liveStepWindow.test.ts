import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { windowLiveTrace, MIN_TRACE_ROWS } from './liveStepWindow';

const thought = (content: string): AgentStep => ({
  type: 'thought',
  content,
  metadata: { timestamp: 0 },
});

const action = (toolName: string, toolInput?: unknown): AgentStep => ({
  type: 'action',
  content: toolName,
  metadata: { timestamp: 0, toolName, toolInput },
});

const observation = (content: string): AgentStep => ({
  type: 'observation',
  content,
  metadata: { timestamp: 0 },
});

describe('windowLiveTrace', () => {
  it('returns the whole trace when it fits the budget', () => {
    const steps = [thought('one'), action('read_local_file'), observation('ok')];

    const result = windowLiveTrace(steps, { rows: 40, columns: 100 });

    expect(result.steps).toEqual(steps);
    expect(result.hiddenSteps).toBe(0);
  });

  it('keeps the newest steps and reports how many were dropped', () => {
    // Each thought renders as a blank margin row plus one wrapped row, and one
    // row of the 10 is held back for the "earlier steps" hint.
    const steps = Array.from({ length: 20 }, (_, i) => thought(`step ${i}`));

    const result = windowLiveTrace(steps, { rows: 10, columns: 100 });

    expect(result.steps).toHaveLength(4);
    expect(result.steps[0].content).toBe('step 16');
    expect(result.steps[result.steps.length - 1].content).toBe('step 19');
    expect(result.hiddenSteps).toBe(16);
  });

  it('keeps the slice contiguous so each action keeps its observation', () => {
    const steps = [
      action('a', { path: 'one' }),
      observation('first result'),
      action('b', { path: 'two' }),
      observation('second result'),
      action('c', { path: 'three' }),
      observation('third result'),
    ];

    const result = windowLiveTrace(steps, { rows: 8, columns: 100 });

    expect(result.steps.map(s => s.type)).toEqual(['action', 'observation', 'action', 'observation']);
    expect(result.steps[0].content).toBe('b');
    expect(result.hiddenSteps).toBe(1);
  });

  it('counts wrapped rows, not step count, against the budget', () => {
    const steps = [thought('a'.repeat(500)), thought('b'.repeat(500)), thought('short')];

    const result = windowLiveTrace(steps, { rows: 12, columns: 100 });

    // Each long thought needs ~1 margin + 6 wrapped rows, so only the last
    // long thought plus the short one fit in 12 rows.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].content.startsWith('b')).toBe(true);
    expect(result.hiddenSteps).toBe(1);
  });

  it('clamps a single step that is taller than the whole budget', () => {
    const steps = [thought('old'), thought('x'.repeat(5000))];

    const result = windowLiveTrace(steps, { rows: 8, columns: 80 });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].content.endsWith('...')).toBe(true);
    // 7 usable rows (the 8th is the blank margin) at 80 - 4 indent - 3 glyph.
    expect(result.steps[0].content.length).toBeLessThanOrEqual(7 * 73);
    expect(result.hiddenSteps).toBe(1);
  });

  it('does not spend budget on thoughts that are configured off', () => {
    const steps = [...Array.from({ length: 10 }, (_, i) => thought(`noise ${i}`)), action('read_local_file')];

    const result = windowLiveTrace(steps, { rows: MIN_TRACE_ROWS, columns: 100, showThoughts: false });

    expect(result.steps[result.steps.length - 1].type).toBe('action');
    // Hidden thoughts are not advertised when the user has them turned off.
    expect(result.hiddenSteps).toBe(0);
  });

  it('never reports a budget below the floor', () => {
    const steps = Array.from({ length: 5 }, (_, i) => thought(`step ${i}`));

    const result = windowLiveTrace(steps, { rows: 0, columns: 100 });

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[result.steps.length - 1].content).toBe('step 4');
  });

  it('handles an empty trace', () => {
    expect(windowLiveTrace([], { rows: 20, columns: 100 })).toEqual({ steps: [], hiddenSteps: 0 });
  });
});
