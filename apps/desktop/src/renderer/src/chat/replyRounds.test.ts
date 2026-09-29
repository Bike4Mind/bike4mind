import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { callsIn, roundsOf } from './replyRounds';

function call(id: string, name = 'bash_execute'): ChatToolCall {
  return { id, name, input: {}, status: 'done' };
}

function message(fields: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    ...fields,
  } as ChatMessage;
}

describe('roundsOf', () => {
  it('collapses a message stored before rounds existed into one round', () => {
    const drawn = roundsOf(message({ content: 'All done.', toolCalls: [call('a'), call('b')] }));

    expect(drawn).toEqual([{ text: 'All done.', toolCallIds: ['a', 'b'] }]);
  });

  it('folds wordless rounds into the round whose prose introduced them', () => {
    const drawn = roundsOf(
      message({
        content: 'Running the tests.\n\nGreen.',
        rounds: [
          { text: 'Running the tests.', toolCallIds: ['a'] },
          { text: '', toolCallIds: ['b'] },
          { text: '', toolCallIds: ['c'] },
          { text: 'Green.', toolCallIds: [] },
        ],
        toolCalls: [call('a'), call('b'), call('c')],
      })
    );

    expect(drawn).toEqual([
      { text: 'Running the tests.', toolCallIds: ['a', 'b', 'c'] },
      { text: 'Green.', toolCallIds: [] },
    ]);
  });

  it("carries a folded round's reasoning into the round it joins", () => {
    const drawn = roundsOf(
      message({
        rounds: [
          { text: 'Running the tests.', toolCallIds: ['a'], reasoning: 'check first' },
          { text: '', toolCallIds: ['b'], reasoning: 'one more' },
        ],
        toolCalls: [call('a'), call('b')],
      })
    );

    expect(drawn).toEqual([
      { text: 'Running the tests.', toolCallIds: ['a', 'b'], reasoning: 'check first\n\none more' },
    ]);
  });

  it('keeps a leading wordless round rather than dropping its calls', () => {
    const drawn = roundsOf(
      message({
        content: 'Found it.',
        rounds: [
          { text: '', toolCallIds: ['a'] },
          { text: 'Found it.', toolCallIds: [] },
        ],
        toolCalls: [call('a')],
      })
    );

    expect(drawn).toEqual([
      { text: '', toolCallIds: ['a'] },
      { text: 'Found it.', toolCallIds: [] },
    ]);
  });
});

describe('callsIn', () => {
  it('takes only its own calls, in the message order, ignoring ids that are gone', () => {
    const calls = callsIn({ text: '', toolCallIds: ['c', 'a', 'gone'] }, [call('a'), call('b'), call('c')]);

    expect(calls.map(entry => entry.id)).toEqual(['a', 'c']);
  });
});
