import { describe, expect, it } from 'vitest';
import type { AgentCheckpoint } from '@bike4mind/agents';
import { LOW_CONFIDENCE_REOPEN_NUDGE, reopenLowConfidenceAnswer } from './reopenLowConfidenceAnswer';

const checkpointWith = (steps: AgentCheckpoint['steps']): AgentCheckpoint =>
  ({ iteration: 2, messages: [{ role: 'user', content: 'q' }], steps }) as unknown as AgentCheckpoint;

describe('reopenLowConfidenceAnswer', () => {
  it('demotes the final answer, appends the nudge step, and hands the model the nudge as the next turn', () => {
    const answer = { type: 'final_answer' as const, content: 'the answer', metadata: { timestamp: 1, iteration: 1 } };
    const reopened = reopenLowConfidenceAnswer(
      checkpointWith([{ type: 'thought', content: 't', metadata: { timestamp: 0 } }, answer]),
      5
    );

    expect(reopened?.steps).toEqual([
      { type: 'thought', content: 't', metadata: { timestamp: 0 } },
      { type: 'thought', content: 'the answer', metadata: { timestamp: 1, iteration: 1 } },
      { type: 'observation', content: LOW_CONFIDENCE_REOPEN_NUDGE, metadata: { timestamp: 5, iteration: 1 } },
    ]);
    expect(reopened?.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the answer' },
      { role: 'user', content: LOW_CONFIDENCE_REOPEN_NUDGE },
    ]);
    expect(reopened?.iteration).toBe(2);
  });

  it('returns null when the checkpoint does not end on a final answer', () => {
    expect(reopenLowConfidenceAnswer(checkpointWith([]))).toBeNull();
    expect(
      reopenLowConfidenceAnswer(checkpointWith([{ type: 'thought', content: 't', metadata: { timestamp: 0 } }]))
    ).toBeNull();
  });
});
