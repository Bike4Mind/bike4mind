import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatReplyRound, ChatStreamEvent } from '@shared/chat';
import { applyReplyDone } from './replyDone';
import { roundsOf } from './replyRounds';

type ReplyDoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

const ARTIFACT = '<artifact type="text/html" title="Demo">\n<b>hi</b>\n</artifact>';

/** A reply as it looks mid-stream: the deltas that arrived, artifact markup and all. */
function streaming(rounds: ChatReplyRound[]): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: rounds.map(round => round.text).join('\n\n'),
    rounds,
  };
}

function done(event: Partial<ReplyDoneEvent>): ReplyDoneEvent {
  return { type: 'done', sessionId: 's1', messageId: 'm1', content: '', ...event };
}

describe('applyReplyDone', () => {
  it('takes the stripped rounds off the event, so the thread stops drawing raw markup', () => {
    // The regression. Main strips per round before it announces the reply, so the event holds
    // clean prose while the message still holds the deltas that carried the markup.
    const message = streaming([{ text: `Here you go.\n\n${ARTIFACT}`, toolCallIds: ['c1'] }]);
    const settled = applyReplyDone(
      message,
      done({ content: 'Here you go.', rounds: [{ text: 'Here you go.', toolCallIds: ['c1'] }] })
    );

    const drawn = roundsOf(settled)
      .map(round => round.text)
      .join('\n');
    expect(drawn).not.toContain('<artifact');
    expect(drawn).toBe('Here you go.');
  });

  it('drops the streamed rounds when the event omits them, so content is what draws', () => {
    // A turn that ran no tools: main sends no `rounds`, and roundsOf rebuilds the single round
    // from `content`. Defaulting to the message's own rounds here would keep the raw markup.
    const message = streaming([{ text: `Made it.\n\n${ARTIFACT}`, toolCallIds: [] }]);
    const settled = applyReplyDone(message, done({ content: 'Made it.' }));

    expect(settled.rounds).toBeUndefined();
    expect(roundsOf(settled).map(round => round.text)).toEqual(['Made it.']);
  });

  it('keeps every round of a resumed turn, not just the ones after the interruption', () => {
    // Continue streams into the SAME message and its done carries seeded + new rounds.
    const message = streaming([
      { text: 'First.', toolCallIds: ['c1'] },
      { text: `Second.\n\n${ARTIFACT}`, toolCallIds: [] },
    ]);
    const settled = applyReplyDone(
      message,
      done({
        content: 'First.\n\nSecond.',
        rounds: [
          { text: 'First.', toolCallIds: ['c1'] },
          { text: 'Second.', toolCallIds: [] },
        ],
      })
    );

    expect(roundsOf(settled).map(round => round.text)).toEqual(['First.', 'Second.']);
  });

  it('carries the reply fields the event brings', () => {
    const settled = applyReplyDone(
      streaming([{ text: 'x', toolCallIds: [] }]),
      done({
        content: 'x',
        stopReason: 'tool_turn_limit',
        artifacts: [{ id: 'a1', type: 'html', mimeType: 'text/html', title: 'Demo', content: '<b>hi</b>' }],
      })
    );

    expect(settled.stopReason).toBe('tool_turn_limit');
    expect(settled.artifacts).toHaveLength(1);
  });

  it('keeps what streamed for the fields the event leaves out', () => {
    const message: ChatMessage = {
      ...streaming([{ text: 'x', toolCallIds: ['c1'] }]),
      toolCalls: [{ id: 'c1', name: 'bash_execute', input: { command: 'ls' }, status: 'done' }],
    };
    const settled = applyReplyDone(message, done({ content: 'x' }));

    expect(settled.toolCalls).toHaveLength(1);
    expect(settled.stopReason).toBeUndefined();
  });

  it('leaves the text a reply with no artifact in it streamed', () => {
    const message = streaming([{ text: 'Plain answer.', toolCallIds: [] }]);
    const settled = applyReplyDone(message, done({ content: 'Plain answer.' }));

    expect(roundsOf(settled).map(round => round.text)).toEqual(['Plain answer.']);
  });
});
