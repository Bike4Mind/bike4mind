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

  it('drops a round that carries only reasoning, since reasoning is not drawn', () => {
    const drawn = roundsOf(
      message({
        content: 'Found it.',
        rounds: [
          { text: '', toolCallIds: [], reasoning: 'planning' },
          { text: 'Found it.', toolCallIds: [] },
        ],
      })
    );

    expect(drawn).toEqual([{ text: 'Found it.', toolCallIds: [] }]);
  });

  // The shape a reply holds for as long as the model reasons before saying anything: an empty
  // transcript is right, and the turn status line is what reports that the turn is working.
  it('draws nothing while a reply is still only reasoning', () => {
    const drawn = roundsOf(message({ rounds: [{ text: '', toolCallIds: [], reasoning: 'planning' }] }));

    expect(drawn).toEqual([]);
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

/**
 * The same turn drawn from the stream and from the store must lay out identically, or the rows
 * rearrange under the reader the moment it settles. The two paths build `rounds` differently on
 * purpose - live folds as it goes, the store keeps one entry per round and folds at draw time -
 * so the only thing that can be asserted is that they DRAW the same, which is what matters.
 */
describe('roundsOf over the same turn, live and settled', () => {
  const calls = [call('a'), call('b')];

  /** The turn as the stream leaves it: a middle round whose whole output was a stray newline. */
  function streamed(): ChatMessage {
    const events: ChatStreamEvent[] = [
      { type: 'delta', sessionId: 's1', messageId: 'm1', text: 'Reading the files.' },
      { type: 'tool-start', sessionId: 's1', messageId: 'm1', call: call('a') },
      { type: 'tool-end', sessionId: 's1', messageId: 'm1', call: call('a') },
      { type: 'delta', sessionId: 's1', messageId: 'm1', text: '\n\n ' },
      { type: 'tool-start', sessionId: 's1', messageId: 'm1', call: call('b') },
      { type: 'tool-end', sessionId: 's1', messageId: 'm1', call: call('b') },
      { type: 'delta', sessionId: 's1', messageId: 'm1', text: '\n\nDone.' },
    ];
    // Opened empty on purpose: the events are what add the calls, and a message that already
    // knows them is treated as a re-delivery and never attached to a round.
    let live = message({});
    for (const event of events) live = applyLiveEvent(live, event);
    return live;
  }

  /** The same turn as main stores it, every round's text trimmed on the way in. */
  function settled(): ChatMessage {
    return message({
      content: 'Reading the files.\n\nDone.',
      rounds: [
        { text: 'Reading the files.', toolCallIds: ['a'] },
        { text: '', toolCallIds: ['b'] },
        { text: 'Done.', toolCallIds: [] },
      ],
      toolCalls: calls,
    });
  }

  function layout(drawn: ReturnType<typeof roundsOf>) {
    return drawn.map(round => ({ prose: round.text.trim(), toolCallIds: round.toolCallIds }));
  }

  it('folds a whitespace-only round while it streams, exactly as it does once stored', () => {
    expect(layout(roundsOf(streamed()))).toEqual(layout(roundsOf(settled())));
  });

  it('draws that turn as two rounds, the silent calls under the prose that opened them', () => {
    expect(layout(roundsOf(streamed()))).toEqual([
      { prose: 'Reading the files.', toolCallIds: ['a', 'b'] },
      { prose: 'Done.', toolCallIds: [] },
    ]);
  });

  // Settled rounds arrive trimmed, so widening the test to whitespace cannot reclassify one:
  // every round the store holds answers both tests the same way.
  it('leaves the spacing of a settled reply alone', () => {
    expect(roundsOf(settled()).map(round => round.text)).toEqual(['Reading the files.', 'Done.']);
    expect(settled().content).toBe('Reading the files.\n\nDone.');
  });
});

describe('callsIn', () => {
  it('takes only its own calls, in the message order, ignoring ids that are gone', () => {
    const calls = callsIn({ text: '', toolCallIds: ['c', 'a', 'gone'] }, [call('a'), call('b'), call('c')]);

    expect(calls.map(entry => entry.id)).toEqual(['a', 'c']);
  });
});
