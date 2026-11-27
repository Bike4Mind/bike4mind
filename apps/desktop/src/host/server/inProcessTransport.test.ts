import { describe, expect, it, vi } from 'vitest';
import {
  HOST_ERROR_CODES,
  HostConnectError,
  HostRequestError,
  hostFailure,
  hostNotification,
  hostResult,
  type HostNotification,
  type HostRequest,
  type HostResponse,
} from '@shared/hostProtocol';
import { createInProcessTransport } from './inProcessTransport';

function fakeServer(answer: (request: HostRequest) => HostResponse | Promise<HostResponse>) {
  let notify: (message: unknown) => void = () => undefined;
  const handled: HostRequest[] = [];
  const close = vi.fn();
  const server = {
    connect: (deliver: (message: HostNotification) => void) => {
      notify = message => deliver(message as HostNotification);
      return {
        handle: async (request: HostRequest) => {
          handled.push(request);
          return answer(request);
        },
        close,
      };
    },
  };
  return { server, handled, close, push: (message: unknown) => notify(message) };
}

describe('createInProcessTransport', () => {
  it('round-trips a request and its result through the wire format', async () => {
    const { server, handled } = fakeServer(request =>
      hostResult(request.id, { echoed: request.params, gone: undefined })
    );
    const transport = createInProcessTransport(server, vi.fn());

    const result = await transport.request('session/get', { sessionId: 's1', dropped: undefined });

    expect(handled).toEqual([{ jsonrpc: '2.0', id: 1, method: 'session/get', params: { sessionId: 's1' } }]);
    expect(result).toEqual({ echoed: { sessionId: 's1' } });
    expect(result).not.toHaveProperty('gone');
  });

  it('rejects with the host error for an error response', async () => {
    const { server } = fakeServer(request =>
      hostFailure(request.id, HOST_ERROR_CODES.snapshotRequired, 'stale', { a: 1 })
    );
    const transport = createInProcessTransport(server, vi.fn());

    const failure = await transport.request('session/subscribe', {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HostRequestError);
    expect(failure).toMatchObject({ code: HOST_ERROR_CODES.snapshotRequired, message: 'stale', data: { a: 1 } });
  });

  it('rejects a response that does not answer the request', async () => {
    const { server } = fakeServer(() => hostResult(99, {}));
    const transport = createInProcessTransport(server, vi.fn());
    await expect(transport.request('session/list')).rejects.toMatchObject({ code: HOST_ERROR_CODES.internalError });
  });

  it('delivers notifications as parsed copies and reports malformed ones', () => {
    const { server, push } = fakeServer(request => hostResult(request.id, {}));
    const reportError = vi.fn();
    const transport = createInProcessTransport(server, reportError);
    const received: HostNotification[] = [];
    transport.onNotification(message => received.push(message));

    const params = { summary: { id: 's1' } };
    push(hostNotification('session/summaryChanged', params));
    push({ jsonrpc: '1.0', method: 'session/summaryChanged' });
    push(hostResult(1, {}));

    expect(received).toEqual([{ jsonrpc: '2.0', method: 'session/summaryChanged', params }]);
    expect(received[0].params).not.toBe(params);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it('closes the server connection once and refuses requests after', async () => {
    const { server, close, push } = fakeServer(request => hostResult(request.id, {}));
    const transport = createInProcessTransport(server, vi.fn());
    const listener = vi.fn();
    const closed = vi.fn();
    transport.onNotification(listener);
    transport.onClose(closed);

    transport.close();
    transport.close();
    push(hostNotification('session/summaryChanged', { summary: { id: 's1' } }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledExactlyOnceWith({ initiator: 'client' });
    await expect(transport.request('session/list')).rejects.toBeInstanceOf(HostConnectError);
  });

  it('rejects a request still pending when the connection closes', async () => {
    let answer: ((response: HostResponse) => void) | undefined;
    const { server } = fakeServer(
      () =>
        new Promise<HostResponse>(resolve => {
          answer = resolve;
        })
    );
    const transport = createInProcessTransport(server, vi.fn());
    const pending = transport.request('session/list');
    await Promise.resolve();
    transport.close();
    answer?.(hostResult(1, {}));
    await expect(pending).rejects.toThrow('closed');
  });
});
