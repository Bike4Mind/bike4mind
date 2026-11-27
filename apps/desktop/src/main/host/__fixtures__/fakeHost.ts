import type { HostAccount, HostInfo } from '@shared/hostConnection';
import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  HostConnectError,
  HostRequestError,
  hostMethods,
  hostNotification,
  negotiateHostProtocol,
  type HostCloseReason,
  type HostConnectFailure,
  type HostNotification,
  type HostProtocolVersion,
  type HostTransport,
} from '@shared/hostProtocol';
import type { HostConnector } from '../HostLink';

export const ACCOUNT = { userId: 'u1', environmentUrl: 'https://app.example.test' } as const;

export function hostInfo(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    hostId: 'devbox-id',
    hostName: 'devbox',
    hostVersion: '1.0.0',
    protocol: HOST_PROTOCOL_VERSION,
    capabilities: [],
    platform: 'linux',
    homeDirectory: '/home/dev',
    account: ACCOUNT,
    ...overrides,
  };
}

type Pending = { reject(error: unknown): void };

/** A session/event notification as a host sends it. */
export const sessionEvent = (sessionId: string, seq: number): HostNotification =>
  hostNotification('session/event', { sessionId, seq, event: { type: 'text', sessionId, seq } });

/**
 * One connection to a FakeHost. Follows the HostTransport contract (ordered delivery, pending
 * requests reject once closed) unless a test asks it to misbehave.
 */
export class FakeConnection implements HostTransport {
  readonly subscriptions = new Set<string>();
  readonly requests: Array<{ method: string; params: unknown }> = [];
  closedBy: HostCloseReason['initiator'] | null = null;
  private readonly listeners = new Set<(notification: HostNotification) => void>();
  private readonly closeListeners = new Set<(reason: HostCloseReason) => void>();
  private readonly pending = new Set<Pending>();
  /** Every listener ever attached, for delivering a notification that arrives after the close. */
  private readonly everyListener: Array<(notification: HostNotification) => void> = [];

  constructor(private readonly host: FakeHost) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedBy) throw this.closedError(method);
    this.requests.push({ method, params });
    return new Promise((resolve, reject) => {
      const entry: Pending = { reject };
      this.pending.add(entry);
      this.host.answer(this, method, params).then(
        result => {
          if (!this.pending.delete(entry)) return;
          resolve(result);
        },
        (error: unknown) => {
          if (!this.pending.delete(entry)) return;
          reject(error);
        }
      );
    });
  }

  onNotification(listener: (notification: HostNotification) => void): () => void {
    this.listeners.add(listener);
    this.everyListener.push(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: HostCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.end({ initiator: 'client' });
  }

  /** The host or the link went away. */
  cut(failure: HostConnectFailure = { kind: 'lost', detail: 'link cut', stderrTail: '' }): void {
    this.end({ initiator: 'host', failure });
  }

  push(notification: HostNotification): void {
    if (this.closedBy) return;
    for (const listener of [...this.listeners]) listener(notification);
  }

  /** Misbehaves: a notification buffered before the close, delivered after it to every listener ever attached. */
  pushLate(notification: HostNotification): void {
    for (const listener of this.everyListener) listener(notification);
  }

  private end(reason: HostCloseReason): void {
    if (this.closedBy) return;
    this.closedBy = reason.initiator;
    this.host.disconnected(this);
    for (const entry of this.pending) entry.reject(this.closedError('a pending request'));
    this.pending.clear();
    this.listeners.clear();
    for (const listener of [...this.closeListeners]) listener(reason);
    this.closeListeners.clear();
  }

  private closedError(method: string): HostConnectError {
    return new HostConnectError({ kind: 'lost', detail: `closed before ${method}`, stderrTail: '' });
  }
}

/**
 * A host with a per-session event log, served the way HostServer serves it: subscribe replays
 * what follows `after` and then streams live, and a cursor from another epoch needs a snapshot.
 */
export class FakeHost {
  readonly connections: FakeConnection[] = [];
  /** Failures the next connect() calls reject with, in order. */
  readonly connectFailures: HostConnectFailure[] = [];
  protocol: HostProtocolVersion = HOST_PROTOCOL_VERSION;
  account: HostAccount = ACCOUNT;
  epoch = 'epoch-1';
  /** When set, host/info never answers. */
  silent = false;
  /** How long connect() takes, in ms; it opens after this even when no one waits any more. */
  connectDelayMs = 0;
  /** When set, subscribe answers before it replays (a transport that reorders the two). */
  answerBeforeReplay = false;
  /** Methods that are never answered, so a cut can land while they are in flight. */
  readonly unanswered = new Set<string>();
  /** Answers methods the fake does not serve itself. */
  handle: (method: string, params: unknown) => unknown = () => ({});
  private readonly logs = new Map<string, number>();

  readonly connector: HostConnector = {
    connect: async () => {
      const failure = this.connectFailures.shift();
      if (failure) throw new HostConnectError(failure);
      if (this.connectDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.connectDelayMs));
      const connection = new FakeConnection(this);
      this.connections.push(connection);
      return connection;
    },
  };

  get open(): FakeConnection[] {
    return this.connections.filter(connection => !connection.closedBy);
  }

  /** Appends an event to a session's log and streams it to the connections subscribed to it. */
  emit(sessionId: string): number {
    const seq = (this.logs.get(sessionId) ?? 0) + 1;
    this.logs.set(sessionId, seq);
    for (const connection of this.open) {
      if (connection.subscriptions.has(sessionId)) connection.push(sessionEvent(sessionId, seq));
    }
    return seq;
  }

  /** The host restarted: a new epoch, and every connection gone. */
  restart(): void {
    this.epoch = `${this.epoch}+`;
    this.logs.clear();
    for (const connection of this.open) connection.cut();
  }

  setAccount(account: HostAccount): void {
    this.account = account;
    for (const connection of this.open) connection.push(hostNotification('host/stateChanged', { account }));
  }

  disconnected(connection: FakeConnection): void {
    connection.subscriptions.clear();
  }

  async answer(connection: FakeConnection, method: string, params: unknown): Promise<unknown> {
    await Promise.resolve();
    if (this.unanswered.has(method)) return new Promise(() => undefined);
    switch (method) {
      case 'host/initialize': {
        const { protocol } = hostMethods['host/initialize'].params.parse(params);
        const negotiated = negotiateHostProtocol(protocol, this.protocol);
        if (!negotiated.ok) {
          throw new HostRequestError({
            code: HOST_ERROR_CODES.protocolMismatch,
            message: `This host speaks protocol ${this.protocol.major}.x`,
            data: { reason: negotiated.reason, host: this.protocol },
          });
        }
        return hostInfo({ protocol: { major: this.protocol.major, minor: negotiated.minor }, account: this.account });
      }
      case 'host/info':
        if (this.silent) return new Promise(() => undefined);
        return hostInfo({ protocol: this.protocol, account: this.account });
      case 'session/subscribe':
        return this.subscribe(connection, hostMethods['session/subscribe'].params.parse(params));
      case 'session/unsubscribe':
        connection.subscriptions.delete(hostMethods['session/unsubscribe'].params.parse(params).sessionId);
        return {};
      default:
        return this.handle(method, params);
    }
  }

  private subscribe(
    connection: FakeConnection,
    { sessionId, after }: { sessionId: string; after?: { epoch: string; seq: number } | undefined }
  ): { cursor: { epoch: string; seq: number } } {
    if (after && after.epoch !== this.epoch) {
      throw new HostRequestError({ code: HOST_ERROR_CODES.snapshotRequired, message: 'snapshot', data: { sessionId } });
    }
    const head = this.logs.get(sessionId) ?? 0;
    const replay: number[] = [];
    for (let seq = (after?.seq ?? head) + 1; seq <= head; seq += 1) replay.push(seq);
    connection.subscriptions.add(sessionId);
    const send = () => replay.forEach(seq => connection.push(sessionEvent(sessionId, seq)));
    if (this.answerBeforeReplay) setTimeout(send, 0);
    else send();
    return { cursor: { epoch: this.epoch, seq: head } };
  }
}
