import { describe, it, expect } from 'vitest';
import { resolveExecutionQuestId } from './agentExecutor.resolveQuestId';

describe('resolveExecutionQuestId', () => {
  it('prefers the start payload on the first invocation', () => {
    const result = resolveExecutionQuestId({
      startPayloadQuestId: 'quest-from-payload',
      executionLinkedQuestId: 'quest-from-doc',
    });
    expect(result).toBe('quest-from-payload');
  });

  it('falls back to the persisted linkedQuestId on a resumed invocation (no start payload)', () => {
    // A resumed/checkpointed Lambda invocation has no start payload at all - this is the case
    // `linkedQuestId` exists specifically to cover.
    const result = resolveExecutionQuestId({ executionLinkedQuestId: 'quest-from-doc' });
    expect(result).toBe('quest-from-doc');
  });

  it('is undefined when neither source has it - the dispatch-time Quest write failed', () => {
    const result = resolveExecutionQuestId({});
    expect(result).toBeUndefined();
  });
});
