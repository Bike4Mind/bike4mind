import type { HostBridgeResponse, HostNotificationDelivery } from '@shared/hostBridge';
import type { HostAccount, HostConnectionState, HostEntry, HostKind } from '@shared/hostConnection';
import {
  HOST_ERROR_CODES,
  HostConnectError,
  HostRequestError,
  hostMethods,
  isHostMethod,
  type HostError,
} from '@shared/hostProtocol';
import type { ClientIdentity } from './handshake';
import {
  DEFAULT_HOST_LINK_TUNING,
  HostLink,
  REACHABLE_STATUSES,
  sameAccount,
  type HostConnector,
  type HostLinkTuning,
} from './HostLink';
import { WindowConnection } from './WindowConnection';

export { LOCAL_HOST_ID } from '@shared/hostBridge';
export type { HostConnector } from './HostLink';
export type { ClientIdentity } from './handshake';

/** A window, as far as host connections care: where its notifications go and when it is gone. */
export type HostClientEndpoint = {
  readonly id: number;
  deliver(delivery: HostNotificationDelivery): void;
  /** Called once, when the window is destroyed. */
  onClosed(listener: () => void): void;
  /** True once the window is destroyed; onClosed never fires for a window already gone. */
  isClosed(): boolean;
};

/** Wake and network signals; in Desktop, powerMonitor and `net` (see systemSignals.ts). */
export type SystemSignals = {
  isOnline(): boolean;
  onWake(listener: () => void): () => void;
  onOnline(listener: () => void): () => void;
};

export type DesktopAccountSource = {
  current(): HostAccount;
  onChanged(listener: (account: HostAccount) => void): () => void;
};

export type ConnectionManagerOptions = {
  client: ClientIdentity;
  account: DesktopAccountSource;
  signals?: SystemSignals;
  tuning?: Partial<HostLinkTuning>;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
};

/** What the user asked of a host through connect, disconnect or remove, for a registrant that keeps its own record. */
export type HostUserAction = 'connect' | 'disconnect' | 'remove';

export type HostRegistration = {
  label: string;
  kind: HostKind;
  /** Default true. */
  connect?: boolean;
  /** When the host was last reachable, from an earlier run; offline states report it until the host is seen again. */
  lastSeenAt?: number | null;
  /** Called after connect, disconnect or remove has acted on this host; never for register or unregister. */
  onUserAction?(action: HostUserAction): void;
  /** Whether the user agreed to installs on this host; shown on its entry. Omitted for hosts that have no such record. */
  installConsent?(): boolean;
};

type RegisteredHost = {
  link: HostLink;
  label: string;
  windows: Map<number, WindowConnection>;
  onUserAction(action: HostUserAction): void;
  installConsent?(): boolean;
};

/** The `host/*` methods reach a host whose control connection is up, signed in or not; the rest need `connected`. */
const servesMethod = (state: HostConnectionState, method: string): boolean =>
  state.status === 'connected' || (method.startsWith('host/') && REACHABLE_STATUSES.has(state.status));

const failure = (code: number, message: string, data?: unknown): HostBridgeResponse => ({
  ok: false,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const asHostError = (error: unknown): HostError => {
  if (error instanceof HostRequestError) return error.toHostError();
  if (error instanceof HostConnectError) {
    return { code: HOST_ERROR_CODES.capabilityUnavailable, message: `Host connection lost: ${error.message}` };
  }
  return { code: HOST_ERROR_CODES.internalError, message: error instanceof Error ? error.message : String(error) };
};

const ALWAYS_ONLINE: SystemSignals = {
  isOnline: () => true,
  onWake: () => () => undefined,
  onOnline: () => () => undefined,
};

/**
 * The hosts this Desktop can reach, and each window's connection to them. Every host has one
 * control connection (its HostLink), which decides the state the rest of Desktop sees. Every
 * window is its own protocol client: it holds one WindowConnection per host it has spoken to, so
 * a session's events reach only the windows subscribed to it, and a destroyed window's
 * subscriptions end with its connections. Window connections close whenever their host is not
 * `connected` and resume when it is connected again.
 */
export class ConnectionManager {
  private readonly hosts = new Map<string, RegisteredHost>();
  private readonly endpoints = new Set<number>();
  private readonly listeners = new Set<(hosts: HostEntry[]) => void>();
  private readonly tuning: HostLinkTuning;
  private readonly signals: SystemSignals;
  private readonly unsubscribe: Array<() => void>;
  private account: HostAccount;

  constructor(private readonly options: ConnectionManagerOptions) {
    this.tuning = { ...DEFAULT_HOST_LINK_TUNING, ...options.tuning };
    this.signals = options.signals ?? ALWAYS_ONLINE;
    this.account = options.account.current();
    const retryAll = () => {
      for (const host of this.hosts.values()) host.link.retryNow();
    };
    this.unsubscribe = [
      this.signals.onWake(retryAll),
      this.signals.onOnline(retryAll),
      options.account.onChanged(account => this.accountChanged(account)),
    ];
  }

  /** Adds a host and, unless `connect` is false, starts connecting to it. */
  register(hostId: string, connector: HostConnector, registration: HostRegistration): void {
    if (this.hosts.has(hostId)) throw new Error(`Host ${hostId} is already registered`);
    const host: RegisteredHost = {
      link: this.createLink(hostId, connector, registration.kind, registration.lastSeenAt ?? null),
      label: registration.label,
      windows: new Map(),
      onUserAction: registration.onUserAction ?? (() => undefined),
      installConsent: registration.installConsent,
    };
    this.hosts.set(hostId, host);
    if (registration.connect === false) host.link.disconnect('disconnected');
    else host.link.connect();
    this.emit();
  }

  /** Closes every connection to the host and forgets it. */
  unregister(hostId: string): void {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`Host ${hostId} is not registered`);
    this.hosts.delete(hostId);
    for (const window of host.windows.values()) window.close();
    host.windows.clear();
    host.link.dispose();
    this.emit();
  }

  /** Changes the name a host is shown under, e.g. when the route it is reached by changes. */
  relabel(hostId: string, label: string): void {
    const host = this.require(hostId);
    if (host.label === label) return;
    host.label = label;
    this.emit();
  }

  /** Sends the list again after a registrant changed something an entry shows besides its state. */
  refresh(): void {
    this.emit();
  }

  list(): HostEntry[] {
    return [...this.hosts].map(([hostId, host]) => ({
      hostId,
      label: host.label,
      kind: host.link.kind,
      state: host.link.state,
      ...(host.installConsent ? { installConsent: host.installConsent() } : {}),
    }));
  }

  onStateChanged(listener: (hosts: HostEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(hostId: string): void {
    const host = this.require(hostId);
    host.link.connect();
    host.onUserAction('connect');
  }

  /** Disconnects a remote host; the local host serves local chat, so it is never taken offline. */
  disconnect(hostId: string): void {
    const host = this.require(hostId);
    if (host.link.kind === 'local') throw new Error('The local host cannot be disconnected');
    host.link.disconnect('disconnected');
    host.onUserAction('disconnect');
  }

  /** Unregisters a remote host; the local host is part of Desktop and cannot be removed. */
  remove(hostId: string): void {
    const host = this.require(hostId);
    if (host.link.kind === 'local') throw new Error('The local host cannot be removed');
    this.unregister(hostId);
    host.onUserAction('remove');
  }

  /** The sessions a window is subscribed to on a host, as of the host's last answer. */
  subscriptions(clientId: number, hostId: string): ReadonlySet<string> {
    return this.hosts.get(hostId)?.windows.get(clientId)?.subscriptions() ?? new Set();
  }

  /**
   * Arguments arrive from a renderer, so each is checked here before anything is dispatched: the
   * host must be registered and serve the method in its current state, the method one of
   * hostMethods, and the params valid for it. A request made while the host is first connecting
   * waits for that to settle; in any other state but `connected` it fails at once. Never rejects.
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
    if (typeof hostId !== 'string' || !host) {
      return failure(HOST_ERROR_CODES.invalidParams, `Unknown host: ${String(hostId)}`);
    }
    const parsed = hostMethods[method].params.safeParse(params);
    if (!parsed.success) {
      return failure(HOST_ERROR_CODES.invalidParams, `Invalid params for ${method}`, parsed.error.issues);
    }
    await host.link.whenSettled();
    // Checked after the wait: a window closed during it would get a connection nothing releases.
    if (client.isClosed()) return failure(HOST_ERROR_CODES.internalError, 'The window is gone');
    const { state } = host.link;
    if (this.hosts.get(hostId) !== host || !servesMethod(state, method)) {
      return failure(HOST_ERROR_CODES.capabilityUnavailable, `Host ${hostId} is not connected (${state.status})`, {
        state: state.status,
      });
    }
    try {
      // Window connections stay closed until the host is connected, so `host/*` before then goes over the control connection.
      const result =
        state.status === 'connected'
          ? await this.windowConnection(client, hostId, host).request(method, parsed.data)
          : await host.link.request(method, parsed.data);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: asHostError(error) };
    }
  }

  /** Disconnects every host, for app quit. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const hostId of [...this.hosts.keys()]) this.unregister(hostId);
    this.listeners.clear();
  }

  private createLink(hostId: string, connector: HostConnector, kind: HostKind, lastSeenAt: number | null): HostLink {
    return new HostLink({
      hostId,
      kind,
      lastSeenAt,
      connector,
      client: this.options.client,
      desktopAccount: () => this.account,
      isOnline: () => this.signals.isOnline(),
      now: this.options.now ?? Date.now,
      random: this.options.random ?? Math.random,
      tuning: this.tuning,
      onStateChanged: state => this.linkStateChanged(hostId, state),
      log: this.options.log ?? (() => undefined),
    });
  }

  private linkStateChanged(hostId: string, state: HostConnectionState): void {
    const host = this.hosts.get(hostId);
    if (host) {
      if (state.status === 'connected') {
        for (const window of host.windows.values()) void window.resume();
      } else {
        // needsSignIn and accountMismatch too: a window must not get events for sessions it may not read.
        for (const window of host.windows.values()) window.suspend();
      }
    }
    this.emit();
  }

  private accountChanged(account: HostAccount): void {
    if (sameAccount(account, this.account)) return;
    this.account = account;
    for (const host of this.hosts.values()) host.link.accountChanged();
  }

  private windowConnection(client: HostClientEndpoint, hostId: string, host: RegisteredHost): WindowConnection {
    const existing = host.windows.get(client.id);
    if (existing) return existing;
    if (!this.endpoints.has(client.id)) {
      this.endpoints.add(client.id);
      client.onClosed(() => this.release(client.id));
    }
    const created = new WindowConnection({
      hostId,
      open: () => host.link.openClient(),
      deliver: delivery => client.deliver(delivery),
      reportBroken: detail => host.link.reportBroken(detail),
    });
    host.windows.set(client.id, created);
    return created;
  }

  private release(clientId: number): void {
    this.endpoints.delete(clientId);
    for (const host of this.hosts.values()) {
      host.windows.get(clientId)?.close();
      host.windows.delete(clientId);
    }
  }

  private require(hostId: string): RegisteredHost {
    const host = this.hosts.get(hostId);
    if (!host) throw new Error(`Host ${hostId} is not registered`);
    return host;
  }

  private emit(): void {
    const hosts = this.list();
    for (const listener of this.listeners) listener(hosts);
  }
}
