import type { ChatStreamEvent, EventCursor } from '@shared/chat';
import { HOST_ERROR_CODES, HostRequestError, type HostNotificationParams } from '@shared/hostProtocol';
import { hostClient, type HostClient, type HostSessionRef } from './HostClient';

export type SessionEventHandlers = {
  /** Each of the session's events once, in seq order. */
  event(event: ChatStreamEvent): void;
  /**
   * The host no longer holds events this window missed (a host restart, or a gap older than its
   * buffer): read the session again with session/get. Events keep coming without a break.
   */
  resync?(): void;
};

export type SessionEventHub = {
  /** Holds the window's subscription to the session while any caller holds one; returns the release. */
  subscribe(ref: HostSessionRef, handlers: SessionEventHandlers): () => void;
  /**
   * Picks every subscription on `hostId` up again from its cursor, for a connection that was cut
   * and came back. A session whose missed events the host no longer holds is resynced.
   */
  resumeHost(hostId: string): void;
  /**
   * `listener` hears of every resync on a host, and of every resume: the moment to re-read
   * host-wide state that arrives only as whole-state broadcasts (queue/list, taskDecision/list,
   * the session list), since one may have been missed.
   */
  onResync(listener: (hostId: string) => void): () => void;
};

type SessionEvent = HostNotificationParams<'session/event'>;

type Subscription = {
  readonly ref: HostSessionRef;
  readonly handlers: Set<SessionEventHandlers>;
  /** Bumped by each subscribe request, so an answer to a superseded one is ignored. */
  attempt: number;
  /** Events that arrived before the subscribe answer, applied once it says where to start. */
  pending: SessionEvent[] | null;
  /** Null until the first subscribe answers. */
  cursor: EventCursor | null;
};

const keyOf = ({ hostId, sessionId }: HostSessionRef): string => `${hostId}\n${sessionId}`;

const isSnapshotRequired = (error: unknown): boolean =>
  error instanceof HostRequestError && error.code === HOST_ERROR_CODES.snapshotRequired;

/**
 * The window's one subscription per (host, session), shared by every hook that wants the session's
 * events. It applies each event once and in order: it drops one at or below the last seq applied,
 * and on a seq gap or an epoch change resubscribes from its cursor, falling back to a resync when
 * the host answers snapshotRequired. Nothing here is specific to the local host.
 */
export function createSessionEventHub(
  client: Pick<HostClient, 'request' | 'onNotification'>,
  reportError: (message: string, detail: unknown) => void = (message, detail) => console.warn(message, detail)
): SessionEventHub {
  const subscriptions = new Map<string, Subscription>();
  const resyncListeners = new Set<(hostId: string) => void>();
  let stopListening: (() => void) | null = null;

  const each = (subscription: Subscription, call: (handlers: SessionEventHandlers) => void): void => {
    for (const handlers of [...subscription.handlers]) {
      try {
        call(handlers);
      } catch (error) {
        reportError(`A listener for ${subscription.ref.sessionId} failed`, error);
      }
    }
  };

  const announceResync = (hostId: string): void => {
    for (const listener of [...resyncListeners]) {
      try {
        listener(hostId);
      } catch (error) {
        reportError(`A resync listener for host ${hostId} failed`, error);
      }
    }
  };

  const isCurrent = (subscription: Subscription): boolean =>
    subscriptions.get(keyOf(subscription.ref)) === subscription;

  // `after` resumes from a cursor; without it the subscription starts at the host's present and
  // the caller is expected to read the session itself.
  const open = (subscription: Subscription, after?: EventCursor): void => {
    const attempt = ++subscription.attempt;
    subscription.pending = [];
    const { hostId, sessionId } = subscription.ref;
    void client
      .request(hostId, 'session/subscribe', after ? { sessionId, after } : { sessionId })
      .then(({ cursor }) => {
        if (!isCurrent(subscription) || attempt !== subscription.attempt) return;
        // Replayed events can arrive after this answer as well as before it, so the start is the
        // cursor resumed from, not the host's present.
        subscription.cursor = after ?? cursor;
        const held = [...(subscription.pending ?? [])].sort((a, b) => a.seq - b.seq);
        subscription.pending = null;
        for (const event of held) accept(subscription, event);
      })
      .catch((error: unknown) => {
        if (!isCurrent(subscription) || attempt !== subscription.attempt) return;
        if (after && isSnapshotRequired(error)) return resync(subscription);
        // Without a cursor this leaves the entry unopened; the next subscribe() or resumeHost retries it.
        subscription.pending = null;
        reportError(`Could not subscribe to ${sessionId} on host ${hostId}`, error);
      });
  };

  // Subscribed again before the handlers re-read, so that read's cursor is at or past the
  // subscription's and nothing falls between them.
  const resync = (subscription: Subscription): void => {
    subscription.cursor = null;
    open(subscription);
    each(subscription, handlers => handlers.resync?.());
    announceResync(subscription.ref.hostId);
  };

  const accept = (subscription: Subscription, params: SessionEvent): void => {
    if (subscription.pending) {
      subscription.pending.push(params);
      return;
    }
    const cursor = subscription.cursor;
    if (!cursor) return;
    if (params.epoch !== undefined && params.epoch !== cursor.epoch) return resync(subscription);
    if (params.seq <= cursor.seq) return;
    // The events in between were lost on the way; the host replays them from the cursor.
    if (params.seq > cursor.seq + 1) return open(subscription, cursor);
    subscription.cursor = { epoch: cursor.epoch, seq: params.seq };
    each(subscription, handlers => handlers.event(params.event));
  };

  const listen = (): void => {
    stopListening ??= client.onNotification('session/event', (params, hostId) => {
      const subscription = subscriptions.get(keyOf({ hostId, sessionId: params.sessionId }));
      if (subscription) accept(subscription, params);
    });
  };

  return {
    subscribe(ref, handlers) {
      listen();
      const key = keyOf(ref);
      let subscription = subscriptions.get(key);
      if (!subscription) {
        subscription = { ref: { ...ref }, handlers: new Set(), attempt: 0, pending: null, cursor: null };
        subscriptions.set(key, subscription);
        open(subscription);
      } else if (!subscription.cursor && !subscription.pending) {
        open(subscription);
      }
      const held = subscription;
      // A fresh object per call, so the same handlers subscribed twice are released one at a time.
      const entry: SessionEventHandlers = { event: event => handlers.event(event), resync: () => handlers.resync?.() };
      held.handlers.add(entry);
      return () => {
        if (!held.handlers.delete(entry) || held.handlers.size > 0 || !isCurrent(held)) return;
        subscriptions.delete(key);
        // Dropped with the last subscription, so the next one listens on the bridge as it is then.
        if (subscriptions.size === 0) {
          stopListening?.();
          stopListening = null;
        }
        void client.request(ref.hostId, 'session/unsubscribe', { sessionId: ref.sessionId }).catch((error: unknown) => {
          reportError(`Could not unsubscribe from ${ref.sessionId} on host ${ref.hostId}`, error);
        });
      };
    },
    resumeHost(hostId) {
      for (const subscription of subscriptions.values()) {
        if (subscription.ref.hostId !== hostId) continue;
        if (subscription.cursor) open(subscription, subscription.cursor);
        else resync(subscription);
      }
      announceResync(hostId);
    },
    onResync(listener) {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
  };
}

export const sessionEvents: SessionEventHub = createSessionEventHub(hostClient);
