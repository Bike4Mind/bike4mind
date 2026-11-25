import { describe, expect, it, vi } from 'vitest';
import type { HostNotificationDelivery } from '@shared/hostBridge';
import {
  HOST_ERROR_CODES,
  HostRequestError,
  hostNotification,
  type HostNotification,
  type HostTransport,
} from '@shared/hostProtocol';
import { ConnectionManager, LOCAL_HOST_ID, type HostClientEndpoint } from './ConnectionManager';

function fakeTransport(answer: (method: string, params: unknown) => unknown = () => ({})) {
  const listeners = new Set<(notification: HostNotification) => void>();
  const transport = {
    request: vi.fn(async (method: string, params?: unknown) => answer(method, params)),
    onNotification: (listener: (notification: HostNotification) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: vi.fn(),
  } satisfies HostTransport;
  return { transport, push: (notification: HostNotification) => listeners.forEach(listener => listener(notification)) };
}

function fakeWindow(id: number) {
  const delivered: HostNotificationDelivery[] = [];
  let closed: (() => void) | undefined;
  const endpoint: HostClientEndpoint = {
    id,
    deliver: delivery => delivered.push(delivery),
    onClosed: listener => {
      closed = listener;
    },
  };
  return { endpoint, delivered, destroy: () => closed?.() };
}

function managerWithLocalHost(answer?: (method: string, params: unknown) => unknown) {
  const transports: Array<ReturnType<typeof fakeTransport>> = [];
  const manager = new ConnectionManager();
  manager.register(LOCAL_HOST_ID, {
    connect: () => {
      const created = fakeTransport(answer);
      transports.push(created);
      return created.transport;
    },
  });
  return { manager, transports };
}

describe('ConnectionManager', () => {
  it('registers the local host as connected and refuses a second registration', () => {
    const { manager } = managerWithLocalHost();
    expect(manager.hostStates()).toEqual([{ hostId: 'local', state: { status: 'connected' } }]);
    expect(() => manager.register(LOCAL_HOST_ID, { connect: () => fakeTransport().transport })).toThrow(
      'already registered'
    );
  });

  it.each([['session/explode'], ['host:request'], [42], [undefined]])(
    'rejects %s, which is not a host method, without opening a connection',
    async method => {
      const { manager, transports } = managerWithLocalHost();
      const response = await manager.request(fakeWindow(1).endpoint, LOCAL_HOST_ID, method, {});
      expect(response).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.methodNotFound } });
      expect(transports).toEqual([]);
    }
  );

  it('rejects invalid params before dispatch', async () => {
    const { manager, transports } = managerWithLocalHost();
    const response = await manager.request(fakeWindow(1).endpoint, LOCAL_HOST_ID, 'session/get', { sessionId: 1 });
    expect(response).toMatchObject({ ok: false, error: { code: HOST_ERROR_CODES.invalidParams } });
    expect(transports).toEqual([]);
  });

  it('rejects an unknown host and a disconnected one', async () => {
    const { manager } = managerWithLocalHost();
    manager.register(
      'devbox',
      { connect: () => fakeTransport().transport },
      { status: 'disconnected', reason: 'offline' }
    );
    const window = fakeWindow(1).endpoint;

    await expect(manager.request(window, 'nowhere', 'session/list', undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: HOST_ERROR_CODES.invalidParams },
    });
    await expect(manager.request(window, 'devbox', 'session/list', undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: HOST_ERROR_CODES.capabilityUnavailable, message: expect.stringContaining('offline') },
    });
  });

  it('opens one connection per window and host, and returns results and host errors as data', async () => {
    const { manager, transports } = managerWithLocalHost(method => {
      if (method === 'session/get')
        throw new HostRequestError({ code: HOST_ERROR_CODES.sessionNotFound, message: 'gone' });
      return { sessions: [] };
    });
    const first = fakeWindow(1).endpoint;
    const second = fakeWindow(2).endpoint;

    await expect(manager.request(first, LOCAL_HOST_ID, 'session/list', undefined)).resolves.toEqual({
      ok: true,
      result: { sessions: [] },
    });
    await manager.request(first, LOCAL_HOST_ID, 'session/statuses', undefined);
    await expect(manager.request(second, LOCAL_HOST_ID, 'session/get', { sessionId: 's1' })).resolves.toEqual({
      ok: false,
      error: { code: HOST_ERROR_CODES.sessionNotFound, message: 'gone' },
    });

    expect(transports).toHaveLength(2);
    expect(transports[0].transport.request).toHaveBeenCalledTimes(2);
  });

  it('answers a transport that throws something else with an internal error', async () => {
    const { manager } = managerWithLocalHost(() => {
      throw new Error('pipe closed');
    });
    await expect(manager.request(fakeWindow(1).endpoint, LOCAL_HOST_ID, 'session/list', undefined)).resolves.toEqual({
      ok: false,
      error: { code: HOST_ERROR_CODES.internalError, message: 'pipe closed' },
    });
  });

  it('delivers a connection notifications to its own window, tagged with the host', async () => {
    const { manager, transports } = managerWithLocalHost();
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    await manager.request(first.endpoint, LOCAL_HOST_ID, 'session/list', undefined);
    await manager.request(second.endpoint, LOCAL_HOST_ID, 'session/list', undefined);

    const notification = hostNotification('session/summaryChanged', { summary: { id: 's1' } });
    transports[0].push(notification);

    expect(first.delivered).toEqual([{ hostId: LOCAL_HOST_ID, notification }]);
    expect(second.delivered).toEqual([]);
  });

  it('tracks answered subscribes and unsubscribes, but not failed ones', async () => {
    const { manager } = managerWithLocalHost((method, params) => {
      if ((params as { sessionId?: string }).sessionId === 'stale') {
        throw new HostRequestError({ code: HOST_ERROR_CODES.snapshotRequired, message: 'stale' });
      }
      return method === 'session/subscribe' ? { cursor: { epoch: 'e', seq: 0 } } : {};
    });
    const window = fakeWindow(1).endpoint;

    await manager.request(window, LOCAL_HOST_ID, 'session/subscribe', { sessionId: 's1' });
    await manager.request(window, LOCAL_HOST_ID, 'session/subscribe', { sessionId: 's2' });
    await manager.request(window, LOCAL_HOST_ID, 'session/subscribe', {
      sessionId: 'stale',
      after: { epoch: 'x', seq: 1 },
    });
    await manager.request(window, LOCAL_HOST_ID, 'session/unsubscribe', { sessionId: 's1' });

    expect([...manager.subscriptions(1, LOCAL_HOST_ID)]).toEqual(['s2']);
  });

  it('closes a destroyed window connections and drops its subscriptions, leaving other windows alone', async () => {
    const { manager, transports } = managerWithLocalHost(() => ({ cursor: { epoch: 'e', seq: 0 } }));
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    await manager.request(first.endpoint, LOCAL_HOST_ID, 'session/subscribe', { sessionId: 's1' });
    await manager.request(second.endpoint, LOCAL_HOST_ID, 'session/subscribe', { sessionId: 's1' });

    first.destroy();

    expect(transports[0].transport.close).toHaveBeenCalledTimes(1);
    expect(transports[1].transport.close).not.toHaveBeenCalled();
    expect(manager.subscriptions(1, LOCAL_HOST_ID).size).toBe(0);
    expect([...manager.subscriptions(2, LOCAL_HOST_ID)]).toEqual(['s1']);
  });
});
