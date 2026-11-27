import { describe, expect, it } from 'vitest';
import { redactAgentStepsForViewer } from './agentStepRedaction';

const steps = [
  { type: 'thought' as const, content: 'thinking' },
  { type: 'action' as const, content: 'call tool' },
  { type: 'observation' as const, content: 'tool output' },
  { type: 'final_answer' as const, content: 'done' },
];

describe('redactAgentStepsForViewer', () => {
  it('returns the same array for the owner', () => {
    expect(redactAgentStepsForViewer(steps, true)).toBe(steps);
  });

  it('blanks only observation content for a non-owner and does not mutate the input', () => {
    const redacted = redactAgentStepsForViewer(steps, false);

    expect(redacted.map(step => step.content)).toEqual(['thinking', 'call tool', '', 'done']);
    expect(steps[2].content).toBe('tool output');
  });

  it('returns the input when no observation carries content', () => {
    const quiet = [{ type: 'thought' as const, content: 'x' }];
    expect(redactAgentStepsForViewer(quiet, false)).toBe(quiet);
  });
});
