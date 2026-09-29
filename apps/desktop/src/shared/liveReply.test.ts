import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent, ChatToolCall } from './chat';
import { applyLiveEvent, startReply } from './liveReply';

const ids = { sessionId: 's', messageId: 'r' };
const call = (status: ChatToolCall['status']): ChatToolCall =>
  ({ id: 'c1', name: 'file_read', input: {}, status }) as ChatToolCall;

function fold(events: ChatStreamEvent[], messages: ChatMessage[] = []): ChatMessage[] {
  return events.reduce(
    (current, event) =>
      event.type === 'start'
        ? startReply(current, event.messageId)
        : current.map(message => applyLiveEvent(message, event)),
    messages
  );
}

describe('live reply', () => {
  it('builds rounds in order: prose, the tools it announced, then the next prose', () => {
    const [reply] = fold([
      { type: 'start', ...ids },
      { type: 'delta', ...ids, text: 'Looking.' },
      { type: 'tool-start', ...ids, call: call('running') },
      { type: 'tool-progress', ...ids, callId: 'c1', text: 'reading' },
      { type: 'tool-end', ...ids, call: call('done') },
      { type: 'delta', ...ids, text: '\n\nFound it.' },
    ]);

    expect(reply.content).toBe('Looking.\n\nFound it.');
    expect(reply.rounds).toEqual([
      { text: 'Looking.', toolCallIds: ['c1'] },
      { text: 'Found it.', toolCallIds: [] },
    ]);
    expect(reply.toolCalls).toEqual([call('done')]);
  });

  it('continues a resumed reply in place, dropping only its old stop reason', () => {
    const earlier: ChatMessage = {
      id: 'r',
      role: 'assistant',
      content: 'Part one.',
      createdAt: '2026-01-01T00:00:00.000Z',
      stopReason: 'tool_turn_limit',
      rounds: [{ text: 'Part one.', toolCallIds: [] }],
    };

    const [reply] = fold(
      [
        { type: 'start', ...ids },
        { type: 'delta', ...ids, text: ' Part two.' },
      ],
      [earlier]
    );

    expect(reply).toMatchObject({ content: 'Part one. Part two.', stopReason: undefined });
  });

  it('leaves other messages alone', () => {
    const other: ChatMessage = { id: 'u', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' };
    expect(applyLiveEvent(other, { type: 'delta', ...ids, text: 'x' })).toBe(other);
  });

  it('puts reasoning on the round it precedes, opening a new one after tools', () => {
    const [reply] = fold([
      { type: 'start', ...ids },
      { type: 'reasoning', ...ids, text: 'plan' },
      { type: 'delta', ...ids, text: 'Looking.' },
      { type: 'tool-start', ...ids, call: call('done') },
      { type: 'reasoning', ...ids, text: 'next' },
      { type: 'delta', ...ids, text: 'Found it.' },
    ]);

    expect(reply.rounds).toEqual([
      { text: 'Looking.', toolCallIds: ['c1'], reasoning: 'plan' },
      { text: 'Found it.', toolCallIds: [], reasoning: 'next' },
    ]);
    expect(reply.content).toBe('Looking.Found it.');
  });
});
