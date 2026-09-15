import { describe, expect, it } from 'vitest';
import type { AgentStep } from '@bike4mind/agents';
import { extractFinalAnswer } from './extractFinalAnswer';

const finalAnswer = (content: string, timestamp = Date.now()): AgentStep => ({
  type: 'final_answer',
  content,
  metadata: { timestamp },
});

describe('extractFinalAnswer', () => {
  it('returns the LAST final_answer when streaming pushed multiple chunks', () => {
    // ReActAgent's no-tool branch pushes one final_answer per delta, each
    // holding the accumulated text. Only the last entry is the complete reply.
    const steps: AgentStep[] = [
      finalAnswer('Based'),
      finalAnswer('Based on what'),
      finalAnswer('Based on what I know about you, you play chess on Saturdays.'),
    ];
    expect(extractFinalAnswer(steps)).toBe('Based on what I know about you, you play chess on Saturdays.');
  });

  it('returns the only final_answer when streaming produced a single chunk', () => {
    expect(extractFinalAnswer([finalAnswer('Hello.')])).toBe('Hello.');
  });

  it('skips non-final_answer steps and picks the last final_answer', () => {
    const steps: AgentStep[] = [
      { type: 'thought', content: 'thinking…', metadata: { timestamp: 0 } },
      { type: 'action', content: 'tool_x', metadata: { timestamp: 0 } },
      { type: 'observation', content: 'result', metadata: { timestamp: 0 } },
      finalAnswer('Here is your answer.'),
    ];
    expect(extractFinalAnswer(steps)).toBe('Here is your answer.');
  });

  it('returns undefined when no final_answer is present', () => {
    const steps: AgentStep[] = [{ type: 'thought', content: 'thinking…', metadata: { timestamp: 0 } }];
    expect(extractFinalAnswer(steps)).toBeUndefined();
  });

  it('returns undefined for an empty steps array', () => {
    expect(extractFinalAnswer([])).toBeUndefined();
  });
});
