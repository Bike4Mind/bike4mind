import { describe, expect, it } from 'vitest';
import { applyLiveEvent, coalesceLiveEvents, mergeDelta, startReply, type LiveReplyEvent } from './liveReply';
import { readReplyStats } from './replyStats';
import { localRunSettlement } from './runSpend';
import type { ChatMessage, ChatStreamEvent, ChatToolCall } from './chat';

describe('liveReply', () => {
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

    it('resumes a paused reply without its stop or the error that stop left', () => {
      const paused: ChatMessage = {
        id: ids.messageId,
        role: 'assistant',
        content: 'Halfway.',
        createdAt: '2026-01-01T00:00:00.000Z',
        stopReason: 'session_expired',
        error: 'Your session expired before this reply finished.',
      };

      const [reply] = startReply([paused], ids.messageId);

      expect(reply.stopReason).toBeUndefined();
      expect(reply.error).toBeUndefined();
      expect(reply.content).toBe('Halfway.');
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

    describe('mergeDelta', () => {
      const piece = (text: string, seq?: number): Extract<LiveReplyEvent, { type: 'delta' }> => ({
        type: 'delta',
        sessionId: 's',
        messageId: 'm',
        text,
        ...(seq === undefined ? {} : { seq }),
      });

      it('joins the text and keeps the newer seq', () => {
        expect(mergeDelta(piece('a', 1), piece('b', 2))).toMatchObject({ text: 'ab', seq: 2 });
      });

      it('keeps the earlier seq when the newer one is unsequenced', () => {
        expect(mergeDelta(piece('a', 1), piece('b'))).toMatchObject({ text: 'ab', seq: 1 });
      });
    });

    describe('coalesceLiveEvents', () => {
      const events: LiveReplyEvent[] = [
        { type: 'delta', ...ids, text: 'Look' },
        { type: 'delta', ...ids, text: 'ing.' },
        { type: 'tool-start', ...ids, call: call('running') },
        { type: 'tool-end', ...ids, call: call('done') },
        { type: 'delta', ...ids, text: '\n\nFound' },
        { type: 'delta', ...ids, text: ' it.' },
      ];

      it('merges only adjacent deltas, keeping tool events where they fell', () => {
        expect(coalesceLiveEvents(events).map(event => (event.type === 'delta' ? event.text : event.type))).toEqual([
          'Looking.',
          'tool-start',
          'tool-end',
          '\n\nFound it.',
        ]);
      });

      it('folds to the same reply as applying every event one at a time', () => {
        // One started reply for both folds: startReply stamps the clock, which can tick between them.
        const started = startReply([], ids.messageId);
        expect(fold(coalesceLiveEvents(events), started)).toEqual(fold(events, started));
      });

      it('does not merge deltas of different messages', () => {
        const other: LiveReplyEvent = { type: 'delta', sessionId: 's', messageId: 'q', text: 'x' };
        expect(coalesceLiveEvents([events[0], other])).toHaveLength(2);
      });
    });
  });
});

describe('replyStats', () => {
  const totals = { totalMs: 5000, modelMs: 4000, toolMs: 1000 };

  describe('readReplyStats', () => {
    it('keeps well-formed stats whole', () => {
      const stats = {
        ...totals,
        loadMs: 1200,
        firstTokenLoadMs: 1200,
        outputMs: 2000,
        firstTokenMs: 1500,
        reasoningMs: 800,
        reasoningTokens: 40,
        generation: { tokens: 100, ms: 2000, untimedTokens: 1, outputTokens: 120 },
        waitMs: 900,
        firstTokenWaitMs: 900,
        derived: ['reasoningTokens', 'reasoningMs'],
      };
      expect(readReplyStats(stats)).toEqual(stats);
    });

    it.each([
      ['an object', { loadMs: 1 }],
      ['a number', 7],
      ['null', null],
      ['a string', 'loadMs'],
      ['an array holding unknown names', ['nope', 3, null, 'loadMs', 'reasoningMs']],
    ])('ignores derived as %s', (_, derived) => {
      const read = readReplyStats({ ...totals, derived });
      expect(read).toMatchObject(totals);
      if (Array.isArray(derived)) expect(read?.derived).toEqual(['reasoningMs']);
      else expect(read).not.toHaveProperty('derived');
    });

    it('drops optional fields of the wrong type and a malformed generation', () => {
      const read = readReplyStats({
        ...totals,
        loadMs: '5',
        waitMs: NaN,
        firstTokenWaitMs: '1',
        outputMs: Infinity,
        reasoningMs: NaN,
        firstTokenMs: null,
        generation: { tokens: 'many', ms: 10 },
      });
      expect(read).toEqual(totals);
      expect(readReplyStats({ ...totals, generation: 4 })).toEqual(totals);
    });

    it.each([undefined, null, 5, 'stats', [], {}, { totalMs: 1, modelMs: 1 }, { ...totals, totalMs: NaN }])(
      'reads %j as no stats',
      value => {
        expect(readReplyStats(value)).toBeUndefined();
      }
    );
  });
});

describe('runSpend', () => {
  const RUN = 'run-a';

  describe('localRunSettlement', () => {
    it('sums the charges settled under the run, on messages and on rounds', () => {
      const local = localRunSettlement(
        [
          { requestId: 'r1', settled: { creditsCharged: 2, runId: RUN } },
          {
            rounds: [
              { text: '', toolCallIds: [], requestId: 'r2', settled: { creditsCharged: 3, runId: RUN } },
              { text: '', toolCallIds: [], requestId: 'r3', settled: { creditsCharged: 4, runId: RUN } },
            ],
          },
        ],
        RUN
      );
      expect(local).toEqual({ creditsCharged: 9, requests: 3 });
    });

    it('counts a request once when it appears twice', () => {
      const message = { requestId: 'r1', settled: { creditsCharged: 5, runId: RUN } };
      expect(localRunSettlement([message, { ...message }], RUN)).toEqual({ creditsCharged: 5, requests: 1 });
    });

    it('leaves out charges from another run or from no run, so reused conversations add nothing', () => {
      const local = localRunSettlement(
        [
          { requestId: 'old', settled: { creditsCharged: 40 } },
          { requestId: 'other', settled: { creditsCharged: 7, runId: 'run-b' } },
          { requestId: 'r1', settled: { creditsCharged: 1, runId: RUN } },
          { requestId: 'unsettled' },
        ],
        RUN
      );
      expect(local).toEqual({ creditsCharged: 1, requests: 1 });
    });
  });
});
