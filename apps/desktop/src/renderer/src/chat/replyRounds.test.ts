import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { applyLiveEvent } from '@shared/liveReply';
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

  it('keeps a round that carries only reasoning, which now has a row of its own', () => {
    const drawn = roundsOf(
      message({
        content: 'Found it.',
        rounds: [
          { text: '', toolCallIds: [], reasoning: 'planning' },
          { text: 'Found it.', toolCallIds: [] },
        ],
      })
    );

    expect(drawn).toEqual([
      { text: '', toolCallIds: [], reasoning: 'planning' },
      { text: 'Found it.', toolCallIds: [] },
    ]);
  });

  it('carries the reasoning of a wordless round into the round it is folded into', () => {
    const drawn = roundsOf(
      message({
        rounds: [
          { text: 'Looking.', toolCallIds: ['a'], reasoning: 'first thought' },
          { text: '', toolCallIds: ['b'], reasoning: 'second thought' },
        ],
        toolCalls: [call('a'), call('b')],
      })
    );

    expect(drawn).toEqual([
      { text: 'Looking.', toolCallIds: ['a', 'b'], reasoning: 'first thought\n\nsecond thought' },
    ]);
  });

  it('folds a wordless round with no reasoning without inventing an empty one', () => {
    const drawn = roundsOf(
      message({
        rounds: [
          { text: 'Looking.', toolCallIds: ['a'] },
          { text: '', toolCallIds: ['b'] },
        ],
        toolCalls: [call('a'), call('b')],
      })
    );

    expect(drawn).toEqual([{ text: 'Looking.', toolCallIds: ['a', 'b'] }]);
  });

  it('keeps the calls of a reasoning-only round that went on to run tools', () => {
    const drawn = roundsOf(
      message({
        rounds: [
          { text: '', toolCallIds: [], reasoning: 'planning' },
          { text: '', toolCallIds: ['a'] },
        ],
        toolCalls: [call('a')],
      })
    );

    expect(drawn.flatMap(round => round.toolCallIds)).toEqual(['a']);
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

describe('roundsOf while a reply streams', () => {
  const ev = (event: { type: string; text?: string; call?: ChatToolCall }) =>
    ({ sessionId: 's1', messageId: 'm1', ...event }) as ChatStreamEvent;

  it('never moves a call out of the round it was first drawn in', () => {
    const events = [
      ev({ type: 'delta', text: 'Reading.' }),
      ev({ type: 'tool-start', call: call('a') }),
      ev({ type: 'delta', text: '\n' }),
      ev({ type: 'tool-start', call: call('b') }),
      ev({ type: 'delta', text: '\n\nNow editing.' }),
      ev({ type: 'tool-start', call: call('c') }),
      ev({ type: 'delta', text: 'Done.' }),
    ];
    let live = message({});
    const seen = new Map<string, number>();
    for (const event of events) {
      live = applyLiveEvent(live, event);
      roundsOf(live).forEach((round, index) =>
        round.toolCallIds.forEach(id => {
          expect(seen.get(id) ?? index).toBe(index);
          seen.set(id, index);
        })
      );
    }
  });
});
