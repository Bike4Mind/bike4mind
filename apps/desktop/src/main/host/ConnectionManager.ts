import type { HostBridgeResponse, HostNotificationDelivery } from '@shared/hostBridge';
import {
  HOST_ERROR_CODES,
  HostRequestError,
  hostMethods,
  isHostMethod,
  type HostError,
  type HostTransport,
} from '@shared/hostProtocol';

export { LOCAL_HOST_ID } from '@shared/hostBridge';

export type HostConnectionState = { status: 'connected' } | { status: 'disconnected'; reason: string };

/** How to open one client connection to a host. */
export type HostConnector = { connect(): HostTransport };

/** A window, as far as host connections care: where its notifications go and when it is gone. */
export type HostClientEndpoint = {
  readonly id: number;
  deliver(delivery: HostNotificationDelivery): void;
  /** Called once, when the window is destroyed. */
  onClosed(listener: () => void): void;
};

type ClientConnection = { transport: HostTransport; subscriptions: Set<string> };

type RegisteredHost = { connector: HostConnector; state: HostConnectionState };

const failure = (code: number, message: string, data?: unknown): HostBridgeResponse => ({
  ok: false,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const asHostError = (error: unknown): HostError =>
  error instanceof HostRequestError
    ? error.toHostError()
    : { code: HOST_ERROR_CODES.internalError, message: error instanceof Error ? error.message : String(error) };

/**
 * The hosts this Desktop can reach, and each window's connection to them. Every window is its own
 * protocol client: it holds one connection per host it has spoken to, so a session's events reach
 * only the windows subscribed to it, and a destroyed window's subscriptions end with its
 * connections.
 */
export class ConnectionManager {
  private readonly hosts = new Map<string, RegisteredHost>();
  private readonly clients = new Map<number, Map<string, ClientConnection>>();

  register(hostId: string, connector: HostConnector, state: HostConnectionState = { status: 'connected' }): void {
    if (this.hosts.has(hostId)) throw new Error(`Host ${hostId} is already registered`);
    this.hosts.set(hostId, { connector, state });
  }

  hostStates(): Array<{ hostId: string; state: HostConnectionState }> {
    return [...this.hosts].map(([hostId, host]) => ({ hostId, state: host.state }));
  }

  /** The sessions a window is subscribed to on a host, as of its last answered subscribe or unsubscribe. */
  subscriptions(clientId: number, hostId: string): ReadonlySet<string> {
    return this.clients.get(clientId)?.get(hostId)?.subscriptions ?? new Set();
  }

  /**
   * Arguments arrive from a renderer, so each is checked here before anything is dispatched: the
   * host must be registered and connected, the method one of hostMethods, and the params valid
   * for it. Never rejects.
   */
  async request(
    client: HostClientEndpoint,
    hostId: unknown,
    method: unknown,
    params: unknown
  ): Promise<HostBridgeResponse> {
    if (typeof method !== 'string' || !isHostMethod(method)) {
      return failure(HOST_ERROR_CODES.methodNotFound, `Method not found: ${String(method)}`);
    }
    const host = typeof hostId === 'string' ? this.hosts.get(hostId) : undefined;
    if (typeof hostId !== 'string' || !host)
      return failure(HOST_ERROR_CODES.invalidParams, `Unknown host: ${String(hostId)}`);
    if (host.state.status !== 'connected') {
      return failure(HOST_ERROR_CODES.capabilityUnavailable, `Host ${hostId} is not connected: ${host.state.reason}`);
    }
    const parsed = hostMethods[method].params.safeParse(params);
    if (!parsed.success) {
      return failure(HOST_ERROR_CODES.invalidParams, `Invalid params for ${method}`, parsed.error.issues);
    }

    const connection = this.connection(client, hostId, host);
    try {
      const result = await connection.transport.request(method, parsed.data);
      this.track(connection, method, parsed.data);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: asHostError(error) };
    }
  }

  private track(connection: ClientConnection, method: string, params: unknown): void {
    if (method === 'session/subscribe') {
      connection.subscriptions.add(hostMethods['session/subscribe'].params.parse(params).sessionId);
    } else if (method === 'session/unsubscribe') {
      connection.subscriptions.delete(hostMethods['session/unsubscribe'].params.parse(params).sessionId);
    }
  }

  private connection(client: HostClientEndpoint, hostId: string, host: RegisteredHost): ClientConnection {
    let connections = this.clients.get(client.id);
    if (!connections) {
      const created = new Map<string, ClientConnection>();
      connections = created;
      this.clients.set(client.id, created);
      client.onClosed(() => this.release(client.id, created));
    }
    const existing = connections.get(hostId);
    if (existing) return existing;
    const transport = host.connector.connect();
    transport.onNotification(notification => client.deliver({ hostId, notification }));
    const opened: ClientConnection = { transport, subscriptions: new Set() };
    connections.set(hostId, opened);
    return opened;
  }

  private release(clientId: number, connections: Map<string, ClientConnection>): void {
    for (const connection of connections.values()) {
      connection.subscriptions.clear();
      connection.transport.close();
    }
    if (this.clients.get(clientId) === connections) this.clients.delete(clientId);
  }
}
