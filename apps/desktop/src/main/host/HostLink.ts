import type { HostAccount, HostConnectionState, HostInfo, HostKind, HostOfflineReason } from '@shared/hostConnection';
import { HostConnectError, type HostTransport } from '@shared/hostProtocol';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff';
import { initializeHost, measureHost, outcomeForError, type ClientIdentity, type ConnectOutcome } from './handshake';

/** How to open one connection to a host. Rejects with HostConnectError when it cannot. */
export type HostConnector = { connect(): Promise<HostTransport> };

export type HostLinkTuning = {
  backoff: BackoffPolicy;
  /** Failed attempts in a row after which a host shows as offline rather than reconnecting. */
  offlineAfterAttempts: number;
  /** How long a connection must last before the attempt count starts again from one, in ms. */
  stableAfterMs: number;
  /** How often a live control connection is checked with `host/info`, in ms. */
  heartbeatMs: number;
  /** How long `host/initialize` and `host/info` may take before the link counts as lost, in ms. */
  requestTimeoutMs: number;
  /** How long the connector may take to open a connection before the attempt counts as failed, in ms. */
  connectTimeoutMs: number;
};

export const DEFAULT_HOST_LINK_TUNING: HostLinkTuning = {
  backoff: DEFAULT_BACKOFF,
  offlineAfterAttempts: 6,
  stableAfterMs: 30_000,
  heartbeatMs: 30_000,
  requestTimeoutMs: 20_000,
  connectTimeoutMs: 60_000,
};

export type HostLinkOptions = {
  hostId: string;
  kind: HostKind;
  /** When the host was last reachable before this link existed, e.g. in an earlier run. */
  lastSeenAt?: number | null;
  connector: HostConnector;
  client: ClientIdentity;
  /** Desktop's own account; a remote host must be signed in to the same one. */
  desktopAccount(): HostAccount;
  isOnline(): boolean;
  now(): number;
  random(): number;
  tuning: HostLinkTuning;
  onStateChanged(state: HostConnectionState): void;
  log(message: string): void;
};

export const sameAccount = (a: HostAccount, b: HostAccount): boolean =>
  a === b || (a !== null && b !== null && a.userId === b.userId && a.environmentUrl === b.environmentUrl);

/** The states in which the control connection is up, so the `host/*` methods reach the host. */
export const REACHABLE_STATUSES: ReadonlySet<HostConnectionState['status']> = new Set([
  'connected',
  'needsSignIn',
  'accountMismatch',
]);

/**
 * Desktop's control connection to one host, and the state the rest of Desktop sees. It runs the
 * handshake, holds the connection open while the host is reachable, checks it on a heartbeat, and
 * after a loss retries with capped exponential backoff. Only one attempt runs at a time; a
 * disconnect or dispose makes any attempt still in flight discard its result.
 */
export class HostLink {
  private current: HostConnectionState = { status: 'connecting' };
  /** The user's choice: false after disconnect until connect. */
  private wanted = true;
  private control: HostTransport | null = null;
  private detachControl: Array<() => void> = [];
  private generation = 0;
  private attempting = false;
  private attempt = 0;
  private lastSeenAt: number | null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private settledWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: HostLinkOptions) {
    this.lastSeenAt = options.lastSeenAt ?? null;
  }

  get state(): HostConnectionState {
    return this.current;
  }

  get hostId(): string {
    return this.options.hostId;
  }

  get kind(): HostKind {
    return this.options.kind;
  }

  /** Resolves once the host is out of `connecting`, at once when it already is. */
  whenSettled(): Promise<void> {
    if (this.current.status !== 'connecting') return Promise.resolve();
    return new Promise(resolve => this.settledWaiters.push(resolve));
  }

  /** Connects now, skipping any backoff wait. A no-op while connected, reachable or already trying. */
  connect(): void {
    if (this.disposed) return;
    this.wanted = true;
    if (this.attempting || this.control) return;
    this.attempt = 0;
    this.clearRetry();
    this.setState({ status: 'connecting' });
    void this.run();
  }

  /** Closes the control connection and stays offline; only connect, or a sign-in for `signedOut`, starts it again. */
  disconnect(reason: Extract<HostOfflineReason, 'disconnected' | 'signedOut'> = 'disconnected'): void {
    if (reason === 'disconnected') this.wanted = false;
    this.generation += 1;
    this.attempting = false;
    this.attempt = 0;
    this.clearRetry();
    this.dropControl();
    this.setState({ status: 'offline', reason, lastSeenAt: this.lastSeenAt });
  }

  dispose(): void {
    this.disconnect('disconnected');
    this.disposed = true;
    this.releaseWaiters();
  }

  /** Wake or network back: retry a waiting host now and check a live one. */
  retryNow(): void {
    if (this.disposed || !this.wanted) return;
    if (this.control) {
      this.checkNow();
      return;
    }
    const waiting =
      this.current.status === 'reconnecting' ||
      (this.current.status === 'offline' &&
        (this.current.reason === 'noNetwork' || this.current.reason === 'unreachable'));
    if (!waiting && !this.attempting) return;
    // A sleep can strand an attempt mid-connect: a fresh one replaces it, and run's stale checks
    // discard whatever the old one opens.
    this.attempting = false;
    this.clearRetry();
    void this.run();
  }

  /** Desktop's account changed: a remote host is connected again from scratch, so its account is checked again. */
  accountChanged(): void {
    if (this.disposed || this.options.kind === 'local' || !this.wanted) return;
    if (this.options.desktopAccount() === null) {
      this.disconnect('signedOut');
      return;
    }
    this.generation += 1;
    this.attempting = false;
    this.clearRetry();
    this.dropControl();
    this.setState({ status: 'connecting' });
    void this.run();
  }

  /** Another connection to this host failed to open: count it as a loss of the whole link. */
  reportBroken(detail: string): void {
    if (!this.control) return;
    this.lose(`A connection to the host failed: ${detail}`);
  }

  /** Sends a request over the control connection; rejects with HostConnectError when it is down. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.control) {
      return Promise.reject(new HostConnectError({ kind: 'lost', detail: 'Host is not reachable', stderrTail: '' }));
    }
    return this.control.request(method, params);
  }

  /**
   * Opens a further connection for a window and checks its protocol; rejects with HostConnectError,
   * or HostNeedsUserError when the connector finds the host needs an install or update first.
   */
  async openClient(): Promise<HostTransport> {
    const transport = await this.openTransport();
    const handshake = await initializeHost(transport, this.options.client, this.options.tuning.requestTimeoutMs);
    if (handshake.ok) return transport;
    transport.close();
    const detail =
      handshake.outcome.retry === true ? handshake.outcome.failure.detail : `Host is ${handshake.outcome.state.status}`;
    throw new HostConnectError({ kind: 'lost', detail, stderrTail: '' });
  }

  private async run(): Promise<void> {
    const generation = ++this.generation;
    const stale = () => generation !== this.generation || this.disposed;
    if (this.options.kind === 'remote' && this.options.desktopAccount() === null) {
      this.setState({ status: 'offline', reason: 'signedOut', lastSeenAt: this.lastSeenAt });
      return;
    }
    this.attempting = true;
    let transport: HostTransport;
    try {
      transport = await this.openTransport();
    } catch (error) {
      if (stale()) return;
      this.attempting = false;
      this.fail(outcomeForError(error));
      return;
    }
    if (stale()) {
      transport.close();
      return;
    }
    const greeting = await this.greet(transport);
    if (stale()) {
      transport.close();
      return;
    }
    this.attempting = false;
    if (!greeting.ok) {
      transport.close();
      this.fail(greeting.outcome);
      return;
    }
    this.adopt(transport);
    this.evaluate(greeting.info, greeting.latencyMs);
    this.scheduleHeartbeat();
  }

  /** The connector's connect, bounded by connectTimeoutMs; a connection that opens after that is closed. */
  private openTransport(): Promise<HostTransport> {
    const { connectTimeoutMs } = this.options.tuning;
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        const detail = `Opening a connection took longer than ${connectTimeoutMs} ms`;
        reject(new HostConnectError({ kind: 'lost', detail, stderrTail: '' }));
      }, connectTimeoutMs);
      this.options.connector.connect().then(
        transport => {
          clearTimeout(timer);
          if (timedOut) transport.close();
          else resolve(transport);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /**
   * The handshake, then `host/info` so the state starts with a real round trip: the handshake's
   * own time includes the host setting the connection up.
   */
  private async greet(
    transport: HostTransport
  ): Promise<{ ok: true; info: HostInfo; latencyMs: number } | { ok: false; outcome: ConnectOutcome }> {
    const { requestTimeoutMs } = this.options.tuning;
    const handshake = await initializeHost(transport, this.options.client, requestTimeoutMs);
    if (!handshake.ok) return handshake;
    try {
      return { ok: true, ...(await measureHost(transport, requestTimeoutMs, this.options.now)) };
    } catch (error) {
      return { ok: false, outcome: outcomeForError(error) };
    }
  }

  private adopt(transport: HostTransport): void {
    this.control = transport;
    this.detachControl = [
      transport.onClose(reason => {
        if (reason.initiator === 'host' && this.control === transport) this.lose(reason.failure.detail);
      }),
      transport.onNotification(notification => {
        if (this.control === transport && notification.method === 'host/stateChanged') this.checkNow();
      }),
    ];
    this.clearStable();
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, this.options.tuning.stableAfterMs);
  }

  /** Decides between connected, needsSignIn and accountMismatch for a host whose control connection is up. */
  private evaluate(info: HostInfo, latencyMs: number): void {
    this.lastSeenAt = this.options.now();
    if (this.options.kind === 'remote') {
      const desktop = this.options.desktopAccount();
      if (info.account === null) {
        this.setState({ status: 'needsSignIn' });
        return;
      }
      if (!sameAccount(info.account, desktop)) {
        this.setState({ status: 'accountMismatch', hostAccount: info.account });
        return;
      }
    }
    this.setState({ status: 'connected', info, latencyMs });
  }

  private checkNow(): void {
    this.clearHeartbeat();
    const transport = this.control;
    if (!transport) return;
    measureHost(transport, this.options.tuning.requestTimeoutMs, this.options.now).then(
      ({ info, latencyMs }) => {
        if (this.control !== transport) return;
        this.evaluate(info, latencyMs);
        this.scheduleHeartbeat();
      },
      (error: unknown) => {
        if (this.control !== transport) return;
        this.lose(`The host stopped answering: ${error instanceof Error ? error.message : String(error)}`);
      }
    );
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => this.checkNow(), this.options.tuning.heartbeatMs);
  }

  private lose(detail: string): void {
    this.options.log(`HOST ${this.options.hostId}: connection lost: ${detail}`);
    this.dropControl();
    this.fail({ retry: true, failure: { kind: 'lost', detail, stderrTail: '' } });
  }

  private fail(outcome: ConnectOutcome): void {
    if (!outcome.retry) {
      this.setState(outcome.state);
      return;
    }
    this.attempt += 1;
    const { tuning } = this.options;
    const delay = backoffDelay(this.attempt, tuning.backoff, this.options.random);
    // Armed even with no network: a short drop the online poll never saw must not strand the host.
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.run();
    }, delay);
    // The local host needs no network, so only a remote one reports its absence.
    if (this.options.kind === 'remote' && !this.options.isOnline()) {
      this.setState({ status: 'offline', reason: 'noNetwork', lastSeenAt: this.lastSeenAt });
      return;
    }
    this.setState(
      this.attempt > tuning.offlineAfterAttempts
        ? { status: 'offline', reason: 'unreachable', lastSeenAt: this.lastSeenAt }
        : { status: 'reconnecting', attempt: this.attempt, nextRetryAt: this.options.now() + delay }
    );
  }

  private dropControl(): void {
    this.clearHeartbeat();
    this.clearStable();
    for (const detach of this.detachControl) detach();
    this.detachControl = [];
    const transport = this.control;
    this.control = null;
    transport?.close();
  }

  private setState(state: HostConnectionState): void {
    this.current = state;
    if (state.status !== 'connecting') this.releaseWaiters();
    this.options.onStateChanged(state);
  }

  private releaseWaiters(): void {
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearStable(): void {
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }
}
