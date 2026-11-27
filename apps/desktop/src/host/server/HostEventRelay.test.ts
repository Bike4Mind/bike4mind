import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import type { HostEventSink } from '../ports';
import { HostEventRelay } from './HostEventRelay';

const recordingSink = (calls: string[], name: string): HostEventSink => ({
  streamEvent: () => calls.push(`${name}:stream`),
  sessionSummary: () => calls.push(`${name}:summary`),
  sessionStatus: () => calls.push(`${name}:status`),
  queueChanged: () => calls.push(`${name}:queue`),
  taskDecisions: () => calls.push(`${name}:decisions`),
  loopChanged: () => calls.push(`${name}:loop`),
});

describe('HostEventRelay', () => {
  it('pushes to the primary sink first, then to each subscriber, until it unsubscribes', () => {
    const calls: string[] = [];
    const relay = new HostEventRelay(vi.fn());
    const sink = relay.tee(recordingSink(calls, 'primary'));
    const unsubscribe = relay.subscribe(recordingSink(calls, 'server'));

    sink.sessionSummary({ id: 's1' } as ChatSessionSummary);
    unsubscribe();
    sink.taskDecisions([]);

    expect(calls).toEqual(['primary:summary', 'server:summary', 'primary:decisions']);
  });

  it('reports a subscriber that throws and still reaches the others', () => {
    const calls: string[] = [];
    const reportError = vi.fn();
    const relay = new HostEventRelay(reportError);
    const sink = relay.tee(recordingSink(calls, 'primary'));
    relay.subscribe({
      ...recordingSink(calls, 'broken'),
      queueChanged: () => {
        throw new Error('boom');
      },
    });
    relay.subscribe(recordingSink(calls, 'server'));

    sink.queueChanged({ sessionId: 's1', queued: [] });

    expect(calls).toEqual(['primary:queue', 'server:queue']);
    expect(reportError).toHaveBeenCalledWith(new Error('boom'));
  });
});
