import type { HostNotificationDelivery } from '@shared/hostBridge';
import {
  HostConnectError,
  hostMethods,
  hostNotification,
  hostNotifications,
  type EventCursor,
  type HostNotification,
  type HostTransport,
} from '@shared/hostProtocol';

/**
 * Where a window is in one session's events. `seq` is the last event delivered to it, or for a
 * subscribe without `after`, the log head the host answered with; null until either is known.
 * `active` once the host has answered the subscribe.
 */
type SessionTrack = { epoch: string | null; seq: number | null; active: boolean };

export type WindowConnectionOptions = {
  hostId: string;
  /** Opens and handshakes a connection; rejects with HostConnectError. */
  open(): Promise<HostTransport>;
  deliver(delivery: HostNotificationDelivery): void;
  /** Whether the host is connected now, so a cut connection may be reopened at once. */
  hostConnected(): boolean;
  /** Opening failed though the host looked reachable: the link should check itself. */
  reportBroken(detail: string): void;
};

const subscribeParams = hostMethods['session/subscribe'].params;
const unsubscribeParams = hostMethods['session/unsubscribe'].params;
const subscribeResult = hostMethods['session/subscribe'].result;
const sessionEventParams = hostNotifications['session/event'].params;

/**
 * One window's protocol connection to one host. It survives the connection under it: when that
 * is cut it reopens (at once, or when the host is connected again), resubscribes each session
 * from the last event the window saw, and drops any event the window already has. A session it
 * cannot resume gets `session/resyncRequired`, after which it is the window's to read again.
 */
export class WindowConnection {
  private transport: HostTransport | null = null;
  private opening: Promise<HostTransport> | null = null;
  private detach: Array<() => void> = [];
  private readonly sessions = new Map<string, SessionTrack>();
  private closed = false;

  constructor(private readonly options: WindowConnectionOptions) {}

  /** The sessions the host has confirmed this window's subscription to. */
  subscriptions(): ReadonlySet<string> {
    return new Set([...this.sessions].filter(([, track]) => track.active).map(([sessionId]) => sessionId));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const transport = await this.ensureOpen();
    if (method === 'session/subscribe') return this.subscribe(transport, subscribeParams.parse(params));
    const result = await transport.request(method, params);
    if (method === 'session/unsubscribe') this.sessions.delete(unsubscribeParams.parse(params).sessionId);
    return result;
  }

  /** Closes the connection under this window and keeps its subscriptions to resume. */
  suspend(): void {
    this.drop();
  }

  /** Reopens a suspended or cut connection and resumes its subscriptions; a no-op when open. */
  async resume(): Promise<void> {
    if (this.closed || this.transport) return;
    // A failure is already reported to the host's link by ensureOpen.
    await this.ensureOpen().catch(() => undefined);
  }

  /** The window is gone: closes for good and forgets everything. */
  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.drop();
  }

  private ensureOpen(): Promise<HostTransport> {
    if (this.closed) {
      return Promise.reject(new HostConnectError({ kind: 'lost', detail: 'The window is gone', stderrTail: '' }));
    }
    if (this.transport) return Promise.resolve(this.transport);
    this.opening ??= this.openAndResume()
      .catch((error: unknown) => {
        if (!this.closed) this.options.reportBroken(error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async openAndResume(): Promise<HostTransport> {
    const transport = await this.options.open();
    if (this.closed) {
      transport.close();
      throw new HostConnectError({ kind: 'lost', detail: 'The window is gone', stderrTail: '' });
    }
    this.transport = transport;
    this.detach = [
      transport.onNotification(notification => {
        if (this.transport === transport) this.receive(notification);
      }),
      transport.onClose(reason => {
        if (this.transport !== transport || reason.initiator !== 'host') return;
        this.drop();
        if (this.options.hostConnected()) void this.resume();
      }),
    ];
    await Promise.all(
      [...this.sessions]
        .filter(([, track]) => track.active)
        .map(([sessionId, track]) => this.resubscribe(transport, sessionId, track))
    );
    return transport;
  }

  private async resubscribe(transport: HostTransport, sessionId: string, track: SessionTrack): Promise<void> {
    if (track.epoch === null || track.seq === null) {
      this.resync(sessionId);
      return;
    }
    try {
      await this.subscribe(transport, { sessionId, after: { epoch: track.epoch, seq: track.seq } });
    } catch {
      // snapshotRequired, or anything else that stops a resume: the window starts over from session/get.
      this.resync(sessionId);
    }
  }

  private resync(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.options.deliver({
      hostId: this.options.hostId,
      notification: hostNotification('session/resyncRequired', { sessionId }),
    });
  }

  /**
   * With `after`, the host replays what follows it and `seq` moves only as those events arrive,
   * whichever comes first of them and the answer. Without it the answer's cursor is the log head,
   * so nothing at or before it is news.
   */
  private async subscribe(
    transport: HostTransport,
    params: { sessionId: string; after?: EventCursor | undefined }
  ): Promise<unknown> {
    const { sessionId, after } = params;
    const track: SessionTrack = { epoch: after?.epoch ?? null, seq: after?.seq ?? null, active: false };
    this.sessions.set(sessionId, track);
    let result: unknown;
    try {
      result = await transport.request('session/subscribe', params);
    } catch (error) {
      if (this.sessions.get(sessionId) === track) this.sessions.delete(sessionId);
      throw error;
    }
    const parsed = subscribeResult.safeParse(result);
    if (parsed.success && this.sessions.get(sessionId) === track) {
      track.epoch = parsed.data.cursor.epoch;
      if (!after) track.seq = Math.max(track.seq ?? -1, parsed.data.cursor.seq);
      track.active = true;
    }
    return result;
  }

  private receive(notification: HostNotification): void {
    if (notification.method === 'session/event') {
      const parsed = sessionEventParams.safeParse(notification.params);
      const track = parsed.success ? this.sessions.get(parsed.data.sessionId) : undefined;
      if (parsed.success && track) {
        if (track.seq !== null && parsed.data.seq <= track.seq) return;
        track.seq = parsed.data.seq;
      }
    }
    this.options.deliver({ hostId: this.options.hostId, notification });
  }

  private drop(): void {
    for (const detach of this.detach) detach();
    this.detach = [];
    const transport = this.transport;
    this.transport = null;
    transport?.close();
  }
}
