import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { applyLiveEvent, startReply } from '@shared/liveReply';
import { SessionEventLog } from './SessionEventLog';

const session = 's1';
const messageId = 'reply-1';
const prompt: ChatMessage = { id: 'prompt', role: 'user', content: 'hello', createdAt: '2026-11-24T00:00:00.000Z' };
const call = (status: ChatToolCall['status']): ChatToolCall => ({
  id: 'call-1',
  name: 'read_file',
  input: { path: 'a.txt' },
  status,
  ...(status === 'done' ? { preview: 'contents' } : {}),
});

const turn: ChatStreamEvent[] = [
  { type: 'start', sessionId: session, messageId },
  { type: 'delta', sessionId: session, messageId, text: 'Let me ' },
  { type: 'delta', sessionId: session, messageId, text: 'look. ' },
  { type: 'tool-start', sessionId: session, messageId, call: call('running') },
  { type: 'tool-progress', sessionId: session, messageId, callId: 'call-1', text: 'read 1 line' },
  { type: 'tool-end', sessionId: session, messageId, call: call('done') },
  { type: 'delta', sessionId: session, messageId, text: 'It says ' },
  { type: 'delta', sessionId: session, messageId, text: 'contents.' },
  {
    type: 'done',
    sessionId: session,
    messageId,
    content: 'Let me look. It says contents.',
    toolCalls: [call('done')],
  },
];

const live = (event: ChatStreamEvent) =>
  event.type === 'delta' || event.type === 'tool-start' || event.type === 'tool-end' || event.type === 'tool-progress';

/** How a client folds an event onto its thread: the renderer's order of operations, minus the UI state. */
function applyToThread(messages: ChatMessage[], event: ChatStreamEvent): ChatMessage[] {
  if (event.type === 'start') return startReply(messages, event.messageId);
  if (event.type === 'done') {
    const base = messages.some(message => message.id === event.messageId)
      ? messages
      : startReply(messages, event.messageId);
    return base.map(message =>
      message.id === event.messageId
        ? { ...message, content: event.content, toolCalls: event.toolCalls ?? message.toolCalls }
        : message
    );
  }
  return messages.map(message => applyLiveEvent(message, event));
}

/**
 * What the host's read hands out after the first `cut` events: the stored transcript, plus the
 * live copy of a reply still streaming (ChatService.getSession folds only live events, and a
 * settled reply is in the store rather than the live copy).
 */
function snapshotAt(cut: number, emitted: ChatStreamEvent[]): ChatMessage[] {
  const seen = emitted.slice(0, cut);
  const settled = seen.find(event => event.type === 'done');
  if (settled && settled.type === 'done') return applyToThread([prompt], settled);
  if (!seen.some(event => event.type === 'start')) return [prompt];
  return seen.filter(live).reduce(applyToThread, startReply([prompt], messageId));
}

const contentOf = (messages: ChatMessage[]) =>
  messages.map(message => ({ id: message.id, content: message.content, toolCalls: message.toolCalls }));

describe('SessionEventLog', () => {
  it.each(Array.from({ length: turn.length + 1 }, (_, cut) => cut))(
    'resumes a snapshot cut after %i events into the same thread as watching from the start',
    cut => {
      const log = new SessionEventLog({ epoch: 'e' });
      const emitted: ChatStreamEvent[] = [];
      let cursor = log.cursor(session);
      turn.forEach((event, index) => {
        emitted.push(log.append(event));
        if (index + 1 === cut) cursor = log.cursor(session);
      });
      expect(cursor.seq).toBe(cut);

      const resumed = log.since(session, cursor);
      if (!resumed.ok) throw new Error('expected the events after the cursor');
      const caughtUp = resumed.events.reduce(applyToThread, snapshotAt(cut, emitted));
      const watched = emitted.reduce(applyToThread, [prompt]);
      expect(contentOf(caughtUp)).toEqual(contentOf(watched));
      expect(resumed.events.map(event => event.seq)).toEqual(emitted.slice(cut).map(event => event.seq));
    }
  );

  it('numbers from 1 and stamps without touching the original event', () => {
    const log = new SessionEventLog();
    const event: ChatStreamEvent = { type: 'start', sessionId: session, messageId };
    expect(log.append(event)).toEqual({ ...event, seq: 1 });
    expect(event.seq).toBeUndefined();
    expect(log.cursor(session)).toEqual({ epoch: log.epoch, seq: 1 });
  });

  it('refuses an event that already carries a seq', () => {
    const log = new SessionEventLog();
    const stamped = log.append({ type: 'start', sessionId: session, messageId });
    expect(() => log.append(stamped)).toThrow(/already carries seq/);
  });

  it('keeps independent counters for interleaved sessions', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    const a = log.append({ type: 'start', sessionId: 'a', messageId: 'ma' });
    const b = log.append({ type: 'start', sessionId: 'b', messageId: 'mb' });
    const a2 = log.append({ type: 'delta', sessionId: 'a', messageId: 'ma', text: 'x' });
    const b2 = log.append({ type: 'delta', sessionId: 'b', messageId: 'mb', text: 'y' });
    expect([a.seq, b.seq, a2.seq, b2.seq]).toEqual([1, 1, 2, 2]);
    expect(log.since('a', { epoch: 'e', seq: 1 })).toEqual({ ok: true, events: [a2] });
    expect(log.since('b', { epoch: 'e', seq: 0 })).toEqual({ ok: true, events: [b, b2] });
  });

  it("continues the count into a second turn and keeps only that turn's events", () => {
    const log = new SessionEventLog({ epoch: 'e' });
    turn.forEach(event => log.append(event));
    const afterFirst = log.cursor(session);
    const second = log.append({ type: 'start', sessionId: session, messageId: 'reply-2' });
    const delta = log.append({ type: 'delta', sessionId: session, messageId: 'reply-2', text: 'again' });
    expect(second.seq).toBe(turn.length + 1);
    expect(log.since(session, afterFirst)).toEqual({ ok: true, events: [second, delta] });
    // The first turn is in the stored transcript now; a cursor inside it must read again.
    expect(log.since(session, { epoch: 'e', seq: 2 })).toEqual({ ok: false, reason: 'snapshot-required' });
  });

  it('returns nothing for a client that is already current', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    expect(log.since(session, { epoch: 'e', seq: 0 })).toEqual({ ok: true, events: [] });
    turn.forEach(event => log.append(event));
    expect(log.since(session, log.cursor(session))).toEqual({ ok: true, events: [] });
  });

  it('asks for a snapshot when the cursor is ahead of the host or from another epoch', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    log.append({ type: 'start', sessionId: session, messageId });
    expect(log.since(session, { epoch: 'e', seq: 2 })).toEqual({ ok: false, reason: 'snapshot-required' });
    expect(log.since(session, { epoch: 'before-restart', seq: 1 })).toEqual({
      ok: false,
      reason: 'snapshot-required',
    });
    expect(log.since('never-seen', { epoch: 'e', seq: 1 })).toEqual({ ok: false, reason: 'snapshot-required' });
  });

  it('asks for a snapshot once the events after the cursor are evicted by count', () => {
    const log = new SessionEventLog({ epoch: 'e', maxEvents: 3 });
    turn.slice(0, 5).forEach(event => log.append(event));
    expect(log.since(session, { epoch: 'e', seq: 1 })).toEqual({ ok: false, reason: 'snapshot-required' });
    const kept = log.since(session, { epoch: 'e', seq: 2 });
    expect(kept.ok && kept.events.map(event => event.seq)).toEqual([3, 4, 5]);
  });

  it('asks for a snapshot once the events after the cursor are evicted by size', () => {
    const big = 'x'.repeat(400);
    const log = new SessionEventLog({ epoch: 'e', maxBytes: 1000 });
    log.append({ type: 'start', sessionId: session, messageId });
    for (let index = 0; index < 4; index++) log.append({ type: 'delta', sessionId: session, messageId, text: big });
    const kept = log.since(session, { epoch: 'e', seq: 3 });
    expect(kept.ok && kept.events.map(event => event.seq)).toEqual([4, 5]);
    expect(log.since(session, { epoch: 'e', seq: 2 })).toEqual({ ok: false, reason: 'snapshot-required' });
  });

  it('asks for a snapshot when a single event is larger than the whole budget', () => {
    const log = new SessionEventLog({ epoch: 'e', maxBytes: 100 });
    log.append({ type: 'start', sessionId: session, messageId });
    log.append({ type: 'delta', sessionId: session, messageId, text: 'x'.repeat(200) });
    expect(log.since(session, { epoch: 'e', seq: 1 })).toEqual({ ok: false, reason: 'snapshot-required' });
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])('asks for a snapshot from a cursor seq of %s', seq => {
    const log = new SessionEventLog({ epoch: 'e' });
    turn.forEach(event => log.append(event));
    expect(log.since(session, { epoch: 'e', seq })).toEqual({ ok: false, reason: 'snapshot-required' });
  });

  it('starts a forgotten session over', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    turn.forEach(event => log.append(event));
    log.forget(session);
    expect(log.cursor(session)).toEqual({ epoch: 'e', seq: 0 });
  });
});

describe('SessionEventLog.rotate', () => {
  const start = (sessionId: string): ChatStreamEvent => ({ type: 'start', sessionId, messageId: 'r' });

  it('gives only that session a new epoch, so a cursor from before stops resolving there alone', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    log.append(start('a'));
    log.append(start('b'));
    const before = log.cursor('a');

    log.rotate('a');

    expect(log.cursor('a').epoch).not.toBe('e');
    expect(log.since('a', before)).toEqual({ ok: false, reason: 'snapshot-required' });
    expect(log.since('b', { epoch: 'e', seq: 0 })).toMatchObject({ ok: true });
  });

  it('keeps counting seq and replays what follows from a cursor taken after it', () => {
    const log = new SessionEventLog({ epoch: 'e' });
    log.append(start('a'));
    log.rotate('a');
    const after = log.cursor('a');
    expect(after.seq).toBe(1);

    const next = log.append({ type: 'delta', sessionId: 'a', messageId: 'r', text: 'x' });
    expect(next.seq).toBe(2);
    expect(log.since('a', after)).toEqual({ ok: true, events: [next] });
  });
});
