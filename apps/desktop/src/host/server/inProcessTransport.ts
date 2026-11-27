import {
  HOST_ERROR_CODES,
  HostConnectError,
  HostRequestError,
  hostRequest,
  isHostNotification,
  isHostRequest,
  isHostResponse,
  parseHostMessage,
  type HostMessage,
  type HostCloseReason,
  type HostNotification,
  type HostTransport,
} from '@shared/hostProtocol';
import type { HostServer } from './HostServer';

// The JSON round trip is the wire's: a value that would not survive the SSH transport fails
// here too, so a host cannot behave differently for the local client than for a remote one.
function overTheWire(message: unknown): HostMessage {
  const parsed = parseHostMessage(JSON.parse(JSON.stringify(message)));
  if (!parsed.ok) throw new HostRequestError(parsed.error);
  return parsed.message;
}

const closedError = (method: string) =>
  new HostConnectError({
    kind: 'lost',
    detail: `Host connection is closed; ${method} was not answered`,
    stderrTail: '',
  });

/**
 * A transport to a HostServer in the same process. Every message is serialised and parsed as
 * a wire message would be, both ways.
 */
export function createInProcessTransport(server: Pick<HostServer, 'connect'>, reportError: (error: unknown) => void) {
  const listeners = new Set<(notification: HostNotification) => void>();
  const closeListeners = new Set<(reason: HostCloseReason) => void>();
  let nextId = 1;
  let closed = false;

  const connection = server.connect(outgoing => {
    try {
      const message = overTheWire(outgoing);
      if (!isHostNotification(message)) throw new Error('The host sent a non-notification message unprompted');
      for (const listener of listeners) listener(message);
    } catch (error) {
      reportError(error);
    }
  });

  const transport: HostTransport = {
    async request(method, params) {
      if (closed) throw closedError(method);
      const request = overTheWire(hostRequest(nextId++, method, params));
      if (!isHostRequest(request)) {
        throw new HostRequestError({ code: HOST_ERROR_CODES.invalidRequest, message: 'Not a request' });
      }
      const handled = await connection.handle(request);
      if (closed) throw closedError(method);
      const response = overTheWire(handled);
      if (!isHostResponse(response) || response.id !== request.id) {
        throw new HostRequestError({ code: HOST_ERROR_CODES.internalError, message: `No response to ${method}` });
      }
      if ('error' in response) throw new HostRequestError(response.error);
      return response.result;
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      connection.close();
      const notify = [...closeListeners];
      closeListeners.clear();
      for (const listener of notify) listener({ initiator: 'client' });
    },
  };
  return transport;
}
