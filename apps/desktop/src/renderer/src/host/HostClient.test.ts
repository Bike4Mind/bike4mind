import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import type { HostBridgeApi, HostNotificationDelivery } from '@shared/hostBridge';
import { HOST_ERROR_CODES, HostRequestError, hostNotification } from '@shared/hostProtocol';
import { createHostClient } from './HostClient';

function fakeBridge(respond: HostBridgeApi['request'] = async () => ({ ok: true, result: {} })) {
  const listeners = new Set<(delivery: HostNotificationDelivery) => void>();
  const bridge: HostBridgeApi = {
    request: vi.fn(respond),
    onNotification: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const deliver = (delivery: HostNotificationDelivery) => listeners.forEach(listener => listener(delivery));
  return { bridge, deliver, listeners };
}

describe('createHostClient', () => {
  it('types requests and results by method', () => {
    const client = createHostClient(() => fakeBridge().bridge);
    expectTypeOf(client.request<'session/list'>)
      .parameter(2)
      .toEqualTypeOf<Record<string, never> | undefined>();
    expectTypeOf(client.request<'session/list'>).returns.resolves.toEqualTypeOf<{ sessions: ChatSessionSummary[] }>();
    expectTypeOf(client.request<'session/rename'>)
      .parameter(2)
      .toEqualTypeOf<{ sessionId: string; title: string }>();
    const neverCalled = () => {
      // @ts-expect-error session/rename's params are required
      void client.request('local', 'session/rename');
      // @ts-expect-error not a host method
      void client.request('local', 'session/explode');
    };
    expect(neverCalled).toBeTypeOf('function');
  });

  it('sends the request over the bridge and returns the validated result', async () => {
    const { bridge } = fakeBridge(async () => ({ ok: true, result: { sessions: [{ id: 's1' }] } }));
    const client = createHostClient(() => bridge);

    await expect(client.request('local', 'session/list')).resolves.toEqual({ sessions: [{ id: 's1' }] });
    expect(bridge.request).toHaveBeenCalledWith('local', 'session/list', undefined);
  });

  it('rejects with the host error', async () => {
    const error = { code: HOST_ERROR_CODES.methodNotFound, message: 'Method not found: fs/browse' };
    const client = createHostClient(() => fakeBridge(async () => ({ ok: false, error })).bridge);

    const failure = await client.request('local', 'fs/browse', {}).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(HostRequestError);
    expect(failure).toMatchObject(error);
  });

  it('rejects a result outside the protocol', async () => {
    const client = createHostClient(() => fakeBridge(async () => ({ ok: true, result: { sessions: 'none' } })).bridge);
    await expect(client.request('local', 'session/list')).rejects.toMatchObject({
      code: HOST_ERROR_CODES.internalError,
    });
  });

  it('fans each notification out to the listeners for its name, with its host', () => {
    const { bridge, deliver, listeners } = fakeBridge();
    const reportError = vi.fn();
    const client = createHostClient(() => bridge, reportError);
    const summaries: Array<[ChatSessionSummary, string]> = [];
    const alsoSummaries = vi.fn();
    const statuses: ChatSessionStatusEvent[] = [];
    client.onNotification('session/summaryChanged', ({ summary }, hostId) => summaries.push([summary, hostId]));
    const off = client.onNotification('session/summaryChanged', alsoSummaries);
    client.onNotification('session/statusChanged', ({ event }) => statuses.push(event));

    deliver({ hostId: 'local', notification: hostNotification('session/summaryChanged', { summary: { id: 's1' } }) });
    off();
    deliver({ hostId: 'devbox', notification: hostNotification('session/summaryChanged', { summary: { id: 's2' } }) });
    deliver({
      hostId: 'local',
      notification: hostNotification('session/summaryChanged', { summary: { title: 'no id' } }),
    });
    deliver({ hostId: 'local', notification: hostNotification('session/somethingNew', { anything: true }) });

    expect(summaries).toEqual([
      [{ id: 's1' }, 'local'],
      [{ id: 's2' }, 'devbox'],
    ]);
    expect(alsoSummaries).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([]);
    // Once, for the summary with no id; a notification name this client does not know is skipped.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(2);
  });
});
