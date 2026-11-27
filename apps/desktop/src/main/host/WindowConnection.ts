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

const superseded = (detail: string) => new HostConnectError({ kind: 'lost', detail, stderrTail: '' });

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
  /** Opening failed, or the host cut this connection: the link treats it as its own loss. */
  reportBroken(detail: string): void;
};

const subscribeParams = hostMethods['session/subscribe'].params;
const unsubscribeParams = hostMethods['session/unsubscribe'].params;
const subscribeResult = hostMethods['session/subscribe'].result;
const sessionEventParams = hostNotifications['session/event'].params;

/**
 * One window's protocol connection to one host. It survives the connection under it: when that
 * is cut or suspended, it reopens once the host is connected again (or on the window's next
 * request), resubscribes each session from the last event the window saw, and drops any event
 * the window already has. A session it cannot resume gets `session/resyncRequired`, after which
 * it is the window's to read again. A cut is reported to the host's link, so reopening is paced
 * by the link's backoff rather than retried here.
 */
export class WindowConnection {
  private transport: HostTransport | null = null;
  private opening: Promise<HostTransport> | null = null;
  private detach: Array<() => void> = [];
  private readonly sessions = new Map<string, SessionTrack>();
  private closed = false;
  /** Bumped by every suspend, cut and close, so an open that finishes after one is discarded. */
  private generation = 0;

  constructor(private readonly options: WindowConnectionOptions) {}

  /** The sessions the host has confirmed this window's subscription to. */
  subscriptions(): ReadonlySet<string> {
    return new Set([...this.sessions].filter(([, track]) => track.active).map(([sessionId]) => sessionId));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const transport = await this.ensureOpen();
    if (method === 'session/subscribe') return this.subscribe(transport, subscribeParams.parse(params));
    if (method === 'session/unsubscribe') return this.unsubscribe(transport, unsubscribeParams.parse(params));
    return transport.request(method, params);
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
    if (this.closed) return Promise.reject(superseded('The window is gone'));
    if (this.transport) return Promise.resolve(this.transport);
    if (this.opening) return this.opening;
    const generation = this.generation;
    const opening = this.openAndResume(generation)
      .catch((error: unknown) => {
        // Only a failure of the current open says anything about the host.
        if (generation === this.generation) {
          this.options.reportBroken(error instanceof Error ? error.message : String(error));
        }
        throw error;
      })
      .finally(() => {
        if (this.opening === opening) this.opening = null;
      });
    this.opening = opening;
    return opening;
  }

  private async openAndResume(generation: number): Promise<HostTransport> {
    const transport = await this.options.open();
    if (generation !== this.generation) {
      transport.close();
      throw superseded('The connection was closed while it opened');
    }
    this.transport = transport;
    this.detach = [
      transport.onNotification(notification => {
        if (this.transport === transport) this.receive(notification);
      }),
      // Not reopened here: the link counts the cut as its own loss, so the reopen waits out its
      // backoff and comes with every other window's when the host is connected again.
      transport.onClose(reason => {
        if (this.transport !== transport || reason.initiator !== 'host') return;
        this.drop();
        this.options.reportBroken(`a window connection closed: ${reason.failure.detail}`);
      }),
    ];
    await Promise.all(
      [...this.sessions]
        .filter(([, track]) => track.active)
        .map(([sessionId, track]) => this.resubscribe(transport, sessionId, track))
    );
    return transport;
  }

  /** Replays from the last delivered event; `seq` moves as the replay arrives, as for any event. */
  private async resubscribe(transport: HostTransport, sessionId: string, track: SessionTrack): Promise<void> {
    if (track.epoch === null || track.seq === null) {
      this.resync(sessionId);
      return;
    }
    try {
      const answer = await transport.request('session/subscribe', {
        sessionId,
        after: { epoch: track.epoch, seq: track.seq },
      });
      const parsed = subscribeResult.safeParse(answer);
      if (parsed.success && this.sessions.get(sessionId) === track) track.epoch = parsed.data.cursor.epoch;
    } catch (error) {
      // Cut again before the host answered: the session waits for the next resume as it is. Checked
      // by error type too, since a transport may reject its pending requests before onClose runs.
      if (error instanceof HostConnectError) return;
      if (this.transport !== transport || this.sessions.get(sessionId) !== track) return;
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
    const previous = this.sessions.get(sessionId);
    const track: SessionTrack = { epoch: after?.epoch ?? null, seq: after?.seq ?? null, active: false };
    this.sessions.set(sessionId, track);
    let result: unknown;
    try {
      result = await transport.request('session/subscribe', params);
    } catch (error) {
      // A failed subscribe leaves the window where it was, still subscribed if it had been.
      if (this.sessions.get(sessionId) === track) {
        if (previous) this.sessions.set(sessionId, previous);
        else this.sessions.delete(sessionId);
      }
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

  /**
   * A cut mid-unsubscribe still forgets the session: the host drops a closed connection's
   * subscriptions, so resuming it would subscribe a session the window asked to drop. A host
   * error answer leaves the subscription as it was.
   */
  private async unsubscribe(transport: HostTransport, params: { sessionId: string }): Promise<unknown> {
    try {
      const result = await transport.request('session/unsubscribe', params);
      this.sessions.delete(params.sessionId);
      return result;
    } catch (error) {
      if (error instanceof HostConnectError) this.sessions.delete(params.sessionId);
      throw error;
    }
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
    this.generation += 1;
    this.opening = null;
    for (const detach of this.detach) detach();
    this.detach = [];
    const transport = this.transport;
    this.transport = null;
    transport?.close();
  }
}
