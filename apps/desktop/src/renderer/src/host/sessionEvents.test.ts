import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent, EventCursor } from '@shared/chat';
import { HOST_ERROR_CODES, HostRequestError, type HostNotificationParams } from '@shared/hostProtocol';
import { createSessionEventHub } from './sessionEvents';

type SessionEvent = HostNotificationParams<'session/event'>;
type Call = { hostId: string; method: string; params: unknown };
type Answer = { resolve(value: unknown): void; reject(error: unknown): void };

/** A host client whose requests wait until the test answers them, and whose events the test sends. */
function fakeClient() {
  const calls: Call[] = [];
  const answers: Answer[] = [];
  const listeners = new Set<(params: SessionEvent, hostId: string) => void>();
  const client = {
    request: vi.fn((hostId: string, method: string, params?: unknown) => {
      calls.push({ hostId, method, params });
      return new Promise((resolve, reject) => answers.push({ resolve, reject }));
    }),
    onNotification: vi.fn((_name: string, listener: (params: SessionEvent, hostId: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    // The fake is structurally the subset the hub calls; the generics of the real client add nothing here.
    client: client as unknown as Parameters<typeof createSessionEventHub>[0],
    calls,
    listeners,
    answer: async (index: number, value: unknown) => {
      answers[index]?.resolve(value);
      await flush();
    },
    fail: async (index: number, error: unknown) => {
      answers[index]?.reject(error);
      await flush();
    },
    send: (seq: number, options: { sessionId?: string; hostId?: string; epoch?: string } = {}) => {
      const sessionId = options.sessionId ?? 's1';
      const event: ChatStreamEvent = { type: 'start', sessionId, messageId: `m${seq}` };
      for (const listener of [...listeners]) {
        listener({ sessionId, seq, epoch: options.epoch ?? 'e1', event }, options.hostId ?? 'local');
      }
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const cursor = (seq: number, epoch = 'e1'): { cursor: EventCursor } => ({ cursor: { epoch, seq } });
const ref = { hostId: 'local', sessionId: 's1' };
const seqsOf = (handler: ReturnType<typeof vi.fn>) =>
  handler.mock.calls.map(([event]) => Number(String((event as { messageId: string }).messageId).slice(1)));

describe('createSessionEventHub', () => {
  it('applies each event once and in order, holding those that arrive before the subscribe answer', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const event = vi.fn();
    hub.subscribe(ref, { event });

    host.send(5);
    host.send(6);
    expect(event).not.toHaveBeenCalled();
    await host.answer(0, cursor(5));
    host.send(6);
    host.send(7);

    expect(seqsOf(event)).toEqual([6, 7]);
    expect(host.calls[0]).toEqual({ hostId: 'local', method: 'session/subscribe', params: { sessionId: 's1' } });
  });

  it('delivers every event to two subscribers of one session over one subscription', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(ref, { event: first });
    hub.subscribe(ref, { event: second });
    await host.answer(0, cursor(0));
    host.send(1);
    host.send(2);

    expect(seqsOf(first)).toEqual([1, 2]);
    expect(seqsOf(second)).toEqual([1, 2]);
    expect(host.calls.filter(call => call.method === 'session/subscribe')).toHaveLength(1);
  });

  it('keeps delivering to the other subscribers when one listener throws', async () => {
    const host = fakeClient();
    const reportError = vi.fn();
    const hub = createSessionEventHub(host.client, reportError);
    const healthy = vi.fn();
    hub.subscribe(ref, {
      event: () => {
        throw new Error('boom');
      },
    });
    hub.subscribe(ref, { event: healthy });
    await host.answer(0, cursor(0));
    host.send(1);

    expect(seqsOf(healthy)).toEqual([1]);
    expect(reportError).toHaveBeenCalledOnce();
  });

  it('resubscribes from its cursor on a seq gap and applies the replay in order', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const event = vi.fn();
    hub.subscribe(ref, { event });
    await host.answer(0, cursor(0));
    host.send(1);
    host.send(3);

    expect(host.calls[1]).toEqual({
      hostId: 'local',
      method: 'session/subscribe',
      params: { sessionId: 's1', after: { epoch: 'e1', seq: 1 } },
    });
    // The replay can land on either side of the answer; both are applied once.
    host.send(2);
    await host.answer(1, cursor(3));
    host.send(3);
    host.send(4);

    expect(seqsOf(event)).toEqual([1, 2, 3, 4]);
  });

  it('resyncs when the host no longer holds the missed events', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const event = vi.fn();
    const resync = vi.fn();
    const announced = vi.fn();
    hub.onResync(announced);
    hub.subscribe(ref, { event, resync });
    await host.answer(0, cursor(0));
    host.send(1);
    host.send(9);
    await host.fail(1, new HostRequestError({ code: HOST_ERROR_CODES.snapshotRequired, message: 'gone' }));

    expect(resync).toHaveBeenCalledOnce();
    expect(announced).toHaveBeenCalledWith('local');
    expect(host.calls[2]).toEqual({ hostId: 'local', method: 'session/subscribe', params: { sessionId: 's1' } });
    await host.answer(2, cursor(12));
    host.send(13);
    expect(seqsOf(event)).toEqual([1, 13]);
  });

  it('resyncs on an epoch change, which is a host that restarted', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const event = vi.fn();
    const resync = vi.fn();
    hub.subscribe(ref, { event, resync });
    await host.answer(0, cursor(4));
    host.send(1, { epoch: 'e2' });

    expect(event).not.toHaveBeenCalled();
    expect(resync).toHaveBeenCalledOnce();
    await host.answer(1, cursor(1, 'e2'));
    host.send(2, { epoch: 'e2' });
    expect(seqsOf(event)).toEqual([2]);
  });

  it('keys subscriptions by host, so the same session id on another host is separate', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const local = vi.fn();
    const remote = vi.fn();
    hub.subscribe(ref, { event: local });
    hub.subscribe({ hostId: 'box', sessionId: 's1' }, { event: remote });
    await host.answer(0, cursor(0));
    await host.answer(1, cursor(0));
    host.send(1, { hostId: 'box' });

    expect(local).not.toHaveBeenCalled();
    expect(seqsOf(remote)).toEqual([1]);
  });

  it('unsubscribes only when the last holder releases, and stops listening when none remain', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const releaseFirst = hub.subscribe(ref, { event: vi.fn() });
    const releaseSecond = hub.subscribe(ref, { event: vi.fn() });
    await host.answer(0, cursor(0));

    releaseFirst();
    expect(host.calls.some(call => call.method === 'session/unsubscribe')).toBe(false);
    releaseSecond();
    expect(host.calls.at(-1)).toEqual({ hostId: 'local', method: 'session/unsubscribe', params: { sessionId: 's1' } });
    expect(host.listeners.size).toBe(0);
  });

  it('picks a host back up from each cursor on resume and announces it', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const announced = vi.fn();
    hub.onResync(announced);
    hub.subscribe(ref, { event: vi.fn() });
    await host.answer(0, cursor(3));

    hub.resumeHost('local');
    expect(host.calls[1]).toEqual({
      hostId: 'local',
      method: 'session/subscribe',
      params: { sessionId: 's1', after: { epoch: 'e1', seq: 3 } },
    });
    expect(announced).toHaveBeenCalledWith('local');
  });

  it('retries a first subscribe that failed when the session is next subscribed', async () => {
    const host = fakeClient();
    const reportError = vi.fn();
    const hub = createSessionEventHub(host.client, reportError);
    const first = vi.fn();
    hub.subscribe(ref, { event: first });
    await host.fail(0, new Error('host busy'));
    expect(reportError).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    hub.subscribe(ref, { event: second });
    expect(host.calls.filter(call => call.method === 'session/subscribe')).toHaveLength(2);
    await host.answer(1, cursor(4));
    host.send(5);
    expect(seqsOf(first)).toEqual([5]);
    expect(seqsOf(second)).toEqual([5]);
  });

  it('applies events held before the subscribe answer in seq order', async () => {
    const host = fakeClient();
    const hub = createSessionEventHub(host.client, vi.fn());
    const handler = vi.fn();
    hub.subscribe(ref, { event: handler });
    host.send(3);
    host.send(2);
    await host.answer(0, cursor(1));
    expect(seqsOf(handler)).toEqual([2, 3]);
  });
});
