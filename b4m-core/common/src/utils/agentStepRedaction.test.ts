import { describe, expect, it } from 'vitest';
import { redactAgentStepsForViewer } from './agentStepRedaction';

const steps = [
  { type: 'thought' as const, content: 'thinking' },
  { type: 'action' as const, content: 'call tool' },
  { type: 'observation' as const, content: 'tool output' },
  { type: 'final_answer' as const, content: 'done' },
];

const richSteps = [
  {
    type: 'action' as const,
    content: 'call tool',
    metadata: { toolName: 'search', toolInput: { query: 'q' }, timestamp: 1, iteration: 0 },
  },
  {
    type: 'observation' as const,
    content: 'tool output',
    metadata: {
      toolName: 'search',
      confidenceReason: 'because',
      confidence: 0.9,
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      timestamp: 2,
      iteration: 0,
    },
  },
];

describe('redactAgentStepsForViewer', () => {
  it('returns the same array for the owner', () => {
    expect(redactAgentStepsForViewer(steps, true)).toBe(steps);
    expect(redactAgentStepsForViewer(richSteps, true)).toBe(richSteps);
  });

  it('blanks only observation content for a non-owner and does not mutate the input', () => {
    const redacted = redactAgentStepsForViewer(steps, false);

    expect(redacted.map(step => step.content)).toEqual(['thinking', 'call tool', '', 'done']);
    expect(steps[2].content).toBe('tool output');
  });

  it('drops tool input and confidence text for a non-owner but keeps the rest of the metadata', () => {
    const redacted = redactAgentStepsForViewer(richSteps, false);

    expect(redacted[0].metadata).toEqual({ toolName: 'search', timestamp: 1, iteration: 0 });
    expect(redacted[1].metadata).toEqual({
      toolName: 'search',
      confidence: 0.9,
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      timestamp: 2,
      iteration: 0,
    });
    expect(redacted[1].content).toBe('');
  });

  it('does not mutate the input metadata', () => {
    redactAgentStepsForViewer(richSteps, false);

    expect(richSteps[0].metadata.toolInput).toEqual({ query: 'q' });
    expect(richSteps[1].metadata.confidenceReason).toBe('because');
    expect(richSteps[1].content).toBe('tool output');
  });

  it('strips tool input even when no observation carries content', () => {
    const inputOnly = [{ type: 'action' as const, content: 'x', metadata: { toolInput: { a: 1 }, timestamp: 1 } }];

    expect(redactAgentStepsForViewer(inputOnly, false)[0].metadata).toEqual({ timestamp: 1 });
  });

  it('returns the input when there is nothing to redact', () => {
    const quiet = [
      { type: 'thought' as const, content: 'x' },
      { type: 'action' as const, content: 'y', metadata: { toolName: 'search', timestamp: 1 } },
      { type: 'observation' as const, content: '' },
    ];
    expect(redactAgentStepsForViewer(quiet, false)).toBe(quiet);
  });
});
