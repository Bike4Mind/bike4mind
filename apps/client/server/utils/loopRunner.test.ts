import { describe, it, expect, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({}));
vi.mock('./loopBudget', () => ({}));
vi.mock('./relayToViewers', () => ({}));

import { runnerFramesToSteps } from './loopRunner';

describe('runnerFramesToSteps', () => {
  it('turns text then a tool call into thought, action and observation, one iteration per tool-end', () => {
    const { steps, relay, iteration, pendingText } = runnerFramesToSteps(
      'run-1',
      [
        { type: 'text', text: 'Let me ' },
        { type: 'text', text: 'look' },
        { type: 'tool-start', callId: 'c1', name: 'grep', input: '{"q":"x"}' },
        { type: 'usage', usage: { inputTokens: 5 } },
        { type: 'tool-end', callId: 'c1', name: 'grep', status: 'ok', preview: '3 hits' },
        { type: 'tool-start', callId: 'c2', name: 'shell', input: 'not json' },
        { type: 'tool-end', callId: 'c2', name: 'shell', status: 'denied', error: 'Denied by policy' },
        { type: 'text', text: 'tail' },
      ],
      { iteration: 4, pendingText: '' },
      1000
    );

    expect(steps.map(step => [step.type, step.content, step.metadata.iteration])).toEqual([
      ['thought', 'Let me look', 4],
      ['action', 'grep', 4],
      ['observation', '3 hits', 4],
      ['action', 'shell', 5],
      ['observation', 'Denied by policy', 5],
    ]);
    expect(steps[1].metadata.toolInput).toEqual({ q: 'x' });
    expect(steps[3].metadata.toolInput).toBe('not json');
    expect(steps[2].metadata.toolFailed).toBeUndefined();
    expect(steps[4].metadata.toolFailed).toBe(true);
    expect({ iteration, pendingText }).toEqual({ iteration: 6, pendingText: 'tail' });
    expect(relay.map(frame => frame.action)).toEqual([
      'agent_text_delta',
      'agent_text_delta',
      'iteration_step',
      'iteration_step',
      'iteration_step',
      'iteration_step',
      'iteration_step',
      'agent_text_delta',
    ]);
    expect(relay.at(-1)).toEqual({ action: 'agent_text_delta', executionId: 'run-1', iteration: 6, delta: 'tail' });
  });

  it('carries buffered text from an earlier post into the next thought', () => {
    const { steps } = runnerFramesToSteps(
      'run-1',
      [{ type: 'tool-start', callId: 'c1', name: 'grep', input: '{}' }],
      { iteration: 0, pendingText: 'from before' },
      1000
    );
    expect(steps[0]).toMatchObject({ type: 'thought', content: 'from before' });
  });
});
