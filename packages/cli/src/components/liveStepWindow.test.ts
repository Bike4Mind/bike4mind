import { describe, it, expect } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { windowLiveTrace, measureTraceRows } from './liveStepWindow';

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

    const result = windowLiveTrace(steps, { rows: 40 });

    expect(result.steps).toEqual(steps);
    expect(result.hiddenSteps).toBe(0);
  });

  it('keeps the newest steps and reports how many were dropped', () => {
    // A thought costs a blank margin row plus its one truncated line, and two of
    // the 12 rows go to the hint line and the box's bottom margin.
    const steps = Array.from({ length: 20 }, (_, i) => thought(`step ${i}`));

    const result = windowLiveTrace(steps, { rows: 12 });

    expect(result.steps).toHaveLength(5);
    expect(result.steps[0].content).toBe('step 15');
    expect(result.steps[result.steps.length - 1].content).toBe('step 19');
    expect(result.hiddenSteps).toBe(15);
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

    const result = windowLiveTrace(steps, { rows: 10 });

    expect(result.steps.map(s => s.type)).toEqual(['action', 'observation', 'action', 'observation']);
    expect(result.steps[0].content).toBe('b');
    expect(result.hiddenSteps).toBe(1);
  });

  it('charges the same rows however long a step is, since live lines truncate', () => {
    const short = Array.from({ length: 6 }, (_, i) => thought(`step ${i}`));
    const long = Array.from({ length: 6 }, (_, i) => thought(`step ${i} ` + 'x'.repeat(5000)));

    const fromShort = windowLiveTrace(short, { rows: 10 });
    const fromLong = windowLiveTrace(long, { rows: 10 });

    expect(fromLong.steps).toHaveLength(fromShort.steps.length);
    expect(fromLong.hiddenSteps).toBe(fromShort.hiddenSteps);
  });

  it('drops the Result line when an action plus its result does not fit', () => {
    const steps = [thought('earlier'), action('read_local_file', { path: '/some/file.tsx' }), observation('done')];

    // Budget of two rows: enough for the action's margin and header, not for the
    // third row its result would take.
    const result = windowLiveTrace(steps, { rows: 4 });

    expect(result.steps.map(s => s.type)).toEqual(['action']);
    expect(result.hiddenSteps).toBe(1);
  });

  it('shows nothing rather than overflow when there is no room at all', () => {
    const steps = [action('read_local_file', { path: '/some/path/file.tsx' }), observation('done')];

    expect(windowLiveTrace(steps, { rows: 3 })).toEqual({ steps: [], hiddenSteps: 0 });
    expect(windowLiveTrace(steps, { rows: 2 })).toEqual({ steps: [], hiddenSteps: 0 });
    expect(windowLiveTrace(steps, { rows: 0 })).toEqual({ steps: [], hiddenSteps: 0 });
    expect(windowLiveTrace(steps, { rows: -5 })).toEqual({ steps: [], hiddenSteps: 0 });
  });

  it('does not spend budget on thoughts that are configured off', () => {
    const steps = [...Array.from({ length: 10 }, (_, i) => thought(`noise ${i}`)), action('read_local_file')];

    const result = windowLiveTrace(steps, { rows: 6, showThoughts: false });

    expect(result.steps[result.steps.length - 1].type).toBe('action');
    // Hidden thoughts are not advertised when the user has them turned off.
    expect(result.hiddenSteps).toBe(0);
  });

  it('handles an empty trace', () => {
    expect(windowLiveTrace([], { rows: 20 })).toEqual({ steps: [], hiddenSteps: 0 });
  });
});

/**
 * The module exists to bound rendered height, so sweep the budget across trace
 * shapes and assert the bound holds. This pins the selection logic against the
 * row model; MessageItem.liveTrace.test.tsx pins the row model itself against
 * real Ink output at real terminal widths.
 */
describe('windowLiveTrace height bound', () => {
  const shapes: Record<string, AgentStep[]> = {
    'short thoughts': Array.from({ length: 40 }, (_, i) => thought(`step ${i}`)),
    'long thoughts': Array.from({ length: 10 }, (_, i) => thought(`${i} `.repeat(400))),
    'one huge thought': [thought('x'.repeat(20_000))],
    'actions with long paths': Array.from({ length: 20 }, (_, i) => [
      action('read_local_file', { path: `/Users/someone/work/repo/packages/cli/src/components/File${i}.tsx` }),
      observation(`Read File${i}.tsx (240 lines) ${'detail '.repeat(30)}`),
    ]).flat(),
    'actions without results': Array.from({ length: 20 }, (_, i) =>
      action('bash_execute', { command: `ls -la /${i}` })
    ),
    'orphan observations': [observation('stray'), observation('stray two')],
  };

  /** Mirrors TRACE_BOX_CHROME_ROWS in liveStepWindow.ts. */
  const TRACE_BOX_CHROME_ROWS = 2;

  for (const [name, steps] of Object.entries(shapes)) {
    for (const showThoughts of [true, false]) {
      it(`stays within budget: ${name}, thoughts ${showThoughts ? 'on' : 'off'}`, () => {
        for (let rows = -2; rows <= 30; rows++) {
          const result = windowLiveTrace(steps, { rows, showThoughts });
          const rendered = measureTraceRows(result.steps, { showThoughts });
          const allowance = result.steps.length > 0 ? rows - TRACE_BOX_CHROME_ROWS : rows;
          expect(rendered, `${name}, ${rows} rows, thoughts ${showThoughts}`).toBeLessThanOrEqual(
            Math.max(0, allowance)
          );
        }
      });
    }
  }
});
