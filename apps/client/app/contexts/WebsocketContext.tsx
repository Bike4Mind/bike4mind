import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ReadyState, useBaseWebsocket } from 'react-use-websocket';
import { HeartbeatAction, IMessageDataToClient, IMessageDataToServer } from '@bike4mind/common';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api, isPublicPath } from '@client/app/contexts/ApiContext';
import { probeIdentity } from '@client/app/utils/sessionBootstrap';
import { WEBSOCKET_TICKET_TIMEOUT_MS } from '@client/app/utils/requestTimeouts';

export { ReadyState };

/**
 * Validates that a WebSocket URL is usable for connection.
 * Returns false for undefined, 'undefined', empty strings, or URLs containing '/undefined'.
 * This guards against build-time env vars that weren't available during Next.js build.
 */
function isValidWebsocketUrl(url: string | undefined): url is string {
  return Boolean(url && url !== 'undefined' && !url.includes('/undefined'));
}

/**
 * Decide whether a WS close event should trigger an auth probe. A close that follows a
 * connect ATTEMPT which never opened (`openedThisAttempt: false`) is the only signal a 401
 * handshake refusal produces - a WS close carries no HTTP status, so this is the closest
 * thing to "the server rejected this connection" the client can observe. An established
 * connection dropping (idle timeout, network blip) is not inherently an auth signal and
 * should NOT probe. mfaPending sessions have no refresh token by design (mirrors the same
 * exclusion in ApiContext's 401 interceptor) - probing would just 401 there for an
 * unrelated reason and is pointless.
 */
export function shouldProbeOnFailedWsConnect(params: {
  openedThisAttempt: boolean;
  accessToken: string | null;
  mfaPending: boolean;
  pathname: string;
}): boolean {
  if (params.openedThisAttempt) return false;
  if (!params.accessToken) return false;
  if (params.mfaPending) return false;
  if (isPublicPath(params.pathname)) return false;
  return true;
}

export interface WebsocketContextValue {
  sendJsonMessage: (action: IMessageDataToServer) => void;
  subscribeToAction: (
    action: IMessageDataToClient['action'],
    callback: (message: IMessageDataToClient) => Promise<void>
  ) => () => void;
  resetLastJsonMessage: () => void;
  readyState: ReadyState;
  activeSubscriptions: ReadonlySet<string>;
  clientId: string;
}

const WebsocketContext = createContext<WebsocketContextValue | null>(null);

const useLastJsonMessage = create<{
  lastJsonMessage: IMessageDataToClient | null;
  setLastJsonMessage: (message: IMessageDataToClient | null) => void;
}>(set => ({
  lastJsonMessage: null,
  setLastJsonMessage: message => set({ lastJsonMessage: message }),
}));

export const useWebsocket = () => {
  const lastJsonMessage = useLastJsonMessage(useShallow(s => s.lastJsonMessage));
  const context = useContext(WebsocketContext);

  if (!context) {
    throw new Error('useWebsocket must be used within a WebsocketProvider');
  }

  return useMemo(
    () => ({ ...context, lastJsonMessage }) as WebsocketContextValue & { lastJsonMessage: IMessageDataToClient },
    [context, lastJsonMessage]
  );
};

/** How often the self-armed retry below checks whether a dead socket should be handed a fresh
 *  reconnect budget. Any value comfortably under the access-token TTL (30 minutes) closes the
 *  gap; it does not translate into reconnect rate, because a single pulse grants a whole new
 *  20-attempt budget (~6 minutes) that has to be spent before the retry can fire again. */
const EXHAUSTED_RETRY_INTERVAL_MS = 30_000;

const HEARTBEAT_MESSAGE = JSON.stringify(HeartbeatAction?.parse({ action: 'heartbeat' }));

/** How long a liveness probe waits for any inbound message before declaring the socket dead. */
export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;
/** Focus, visibilitychange and online often fire together; they share one probe. */
export const LIVENESS_PROBE_DEBOUNCE_MS = 2_000;
/** Cadence of the sleep detector, and how far past it the wall clock must jump to count. */
export const SLEEP_CHECK_INTERVAL_MS = 10_000;
export const SLEEP_GAP_THRESHOLD_MS = 30_000;

interface Props {
  children: React.ReactNode;
  url?: string;
}

export const WebsocketProvider = ({ children, url }: Props) => {
  const didUnmount = useRef(false);
  const setLastJsonMessage = useLastJsonMessage(useShallow(s => s.setLastJsonMessage));
  const accessToken = useAccessToken(useCallback(state => state.accessToken, []));
  const queryClient = useQueryClient();
  // True once `onOpen` has fired for the CURRENT connect attempt; reset on each close.
  // Mirrors the same flag in the CLI's WebSocketConnectionManager.
  const openedThisAttemptRef = useRef(false);
  // True once `onReconnectStop` has fired (the reconnect budget below is exhausted, no pending
  // backoff timer left); reset on the next successful open. Gates every reconnect pulse below
  // so one only fires once there is genuinely nothing left running - see the pulse effect
  // below for why, and its three triggers for what can wake a sleeping socket.
  const reconnectExhaustedRef = useRef(false);
  // Wall-clock time of the last inbound frame (pong included); the liveness probe's evidence.
  const lastMessageAtRef = useRef(0);
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProbeAtRef = useRef(0);

  // Map the action being listened for to the callbacks that want to hear about it
  const listeners = useRef(new Map<string, ((message: IMessageDataToClient) => Promise<void>)[]>());

  const [activeSubscriptions, setActiveSubscriptions] = useState<ReadonlySet<string>>(() => new Set());
  const [clientId] = useState(() => crypto.randomUUID().slice(0, 8));

  // Pulsed true-then-false to force react-use-websocket to tear down and reconnect with a
  // fresh backoff budget (see the visibilitychange effect below). react-use-websocket only
  // resets its internal reconnectCount on a successful connect or when its url argument goes
  // null - the former isn't available to us (the socket isn't open, that's the problem), so a
  // null url is the only lever we have. reconnectCount is capped at DEFAULT_RECONNECT_LIMIT
  // (20 attempts, ~6 minutes of quadratic backoff - see reconnectInterval below); a tab idle
  // longer than that exhausts the budget and onReconnectStop fires. Without this, the socket
  // stays dead until a full reload even after the token refreshes.
  const [forceDisconnected, setForceDisconnected] = useState(false);

  // Only connect when we have both a valid URL and access token
  // URL validation guards against build-time env vars that were undefined
  const shouldConnect = !forceDisconnected && !!accessToken && isValidWebsocketUrl(url);

  // Mint a fresh single-use connect ticket per (re)connect and carry it in the
  // URL instead of the session JWT, so the long-lived credential never lands in
  // proxy/CDN/access logs. `getUrl` re-invokes this on every reconnect and
  // retries on its own backoff if the mint throws - which is why it needs a timeout: a
  // mint that never settles holds readyState at CONNECTING with no retry ever scheduled.
  const getWebsocketUrl = useCallback(async () => {
    const { data } = await api.post<{ ticket: string }>('/api/websocket/ticket', undefined, {
      timeout: WEBSOCKET_TICKET_TIMEOUT_MS,
    });
    return `${url}?ticket=${encodeURIComponent(data.ticket)}`;
  }, [url]);

  const { sendJsonMessage, sendMessage, readyState } = useBaseWebsocket(shouldConnect ? getWebsocketUrl : null, {
    shouldReconnect: () => !didUnmount.current,
    retryOnError: true,
    share: true,
    heartbeat: {
      message: HEARTBEAT_MESSAGE,
      returnMessage: 'pong',
      timeout: 60000, // 1 minute, if no response is received, the connection will be closed
      interval: 15000, // every 15 seconds, a ping message will be sent
    },
    // Quadratic backoff + random jitter so all clients don't reconnect in a synchronized
    // thundering herd after a deploy or network blip. Without jitter, 400 users reconnect
    // at the same instant and flood subscribe_query Lambdas simultaneously.
    reconnectInterval: i => 125 * (i + 1) ** 2 + Math.random() * 1000,
    // Matches the library's own DEFAULT_RECONNECT_LIMIT. Set explicitly (rather than relying
    // on the default) because the shared-listener close handler passes this raw option value
    // to onReconnectStop below instead of its resolved default - leaving it unset means
    // onReconnectStop always logs undefined instead of the real attempt count.
    reconnectAttempts: 20,
    onOpen: () => {
      console.log('ws connected');
      openedThisAttemptRef.current = true;
      reconnectExhaustedRef.current = false;
    },
    onClose(event: CloseEvent) {
      console.log('ws disconnected', event.code, event.reason);
      const openedThisAttempt = openedThisAttemptRef.current;
      openedThisAttemptRef.current = false;

      if (
        shouldProbeOnFailedWsConnect({
          openedThisAttempt,
          accessToken,
          mfaPending: useAccessToken.getState().mfaPending,
          pathname: window.location.pathname,
        })
      ) {
        // A connect ATTEMPT just failed to open while holding a token - the closest signal
        // to "the server rejected this connection" a WS close can carry. probeIdentity's own
        // single-flight (shared with revalidateSessionOnFocus in sessionBootstrap.ts) covers
        // both a burst of close events here and a refocus landing at the same moment, so this
        // reduces to at most one authed round trip either way: refresh -> forceSessionExpiredRedirect
        // on a genuine revocation, or nothing on a network error (WS keeps retrying on its own
        // backoff either way).
        void probeIdentity(queryClient);
      }
    },
    onReconnectStop(numAttempts) {
      console.log('ws reconnect stopped after', numAttempts, 'attempts');
      // No separate probe needed here: the fork calls onClose and onReconnectStop
      // synchronously in the same close-event handler (see attach-shared-listeners.ts), so
      // the FINAL failed attempt's own onClose above has already fired probeIdentity - a
      // second call here would just hit probeIdentity's own in-flight guard and no-op. If
      // that probe refreshes the token, the accessToken effect below turns it into a
      // reconnect pulse with no focus event needed.
      reconnectExhaustedRef.current = true;
    },

    onMessage: event => {
      lastMessageAtRef.current = Date.now();
      try {
        // Ignore empty messages
        if (!event.data) return;
        // Ignore heartbeat responses
        if (event.data === 'pong') return;

        // Check if message looks like JSON before parsing
        const rawData = event.data;

        // Handle SST/AWS error messages that aren't JSON
        if (typeof rawData === 'string' && !rawData.startsWith('{') && !rawData.startsWith('[')) {
          if (rawData.includes('This function is in live debug mode')) {
            console.warn('🔧 [WebSocket] SST dev environment message (ignored):', rawData.substring(0, 100) + '...');
            return;
          }
          if (rawData.includes('AWS') || rawData.includes('sst dev')) {
            console.warn('🔧 [WebSocket] AWS/SST infrastructure message (ignored):', rawData.substring(0, 100) + '...');
            return;
          }
          console.warn('🚨 [WebSocket] Non-JSON message received:', rawData.substring(0, 200));
          return;
        }

        // Distribute everything else
        const data = JSON.parse(rawData);

        // support subscribers
        const actionListeners = listeners.current.get(data.action);
        if (actionListeners?.length) {
          actionListeners.forEach(listener => listener(data).catch(console.error));
        } else {
          setLastJsonMessage(data);
        }
      } catch (error) {
        // Don't log error for known SST messages
        const errorData = event.data;
        if (
          typeof errorData === 'string' &&
          (errorData.includes('This function is in live debug mode') ||
            errorData.includes('AWS') ||
            errorData.includes('sst dev'))
        ) {
          // Known SST infrastructure messages - log at debug level
          console.debug('🔧 [WebSocket] SST infrastructure message (expected in dev)');
          return;
        }

        console.error('🚨 [WebSocket] Error parsing message:');
        console.error('  Event data type:', typeof event.data);
        console.error(
          '  Event data preview:',
          typeof event.data === 'string' ? event.data.substring(0, 200) + '...' : event.data
        );
        console.error('  Parse error:', error);
      }
    },
  });

  const resetLastJsonMessage = useCallback(() => {
    setLastJsonMessage(null);
  }, [setLastJsonMessage]);

  useEffect(() => {
    return () => {
      didUnmount.current = true;
    };
  }, []);

  // Pulse forceDisconnected to force a fresh reconnect attempt with a reset backoff budget -
  // but ONLY once reconnectExhaustedRef is set (onReconnectStop already fired, so there is no
  // pending backoff timer left to cancel). Gating on readyState alone (e.g. "not OPEN") would
  // also pulse mid-backoff: react-use-websocket's own reconnectInterval below deliberately
  // staggers reconnects with jitter to avoid a thundering herd after an outage, and cancelling
  // that on every trigger would defeat it - plus the library never clears its own pending
  // reconnect timer on a url change, so a mid-backoff pulse leaves a second, stale reconnect
  // attempt to fire later. Once genuinely exhausted there is no such timer left, so this has
  // neither problem. Shared by all three triggers below (refocus, a post-exhaustion token
  // refresh, and the self-armed retry) - see each effect's own comment for why one trigger
  // isn't enough. The exhausted flag alone is the gate: onReconnectStop is the only thing that
  // sets it and it fires with the socket already closed, while onOpen is the only thing that
  // clears it - so it cannot be true behind a live connection, and no separate readyState
  // check (which would read a render-stale value) can add anything.
  const pulseReconnect = useCallback(() => {
    if (!reconnectExhaustedRef.current) return;
    // Clear it now, not on the next onOpen: the fresh budget this pulse grants means the
    // socket is no longer "exhausted" the instant we hand it that budget, regardless of
    // whether the resulting attempt succeeds. Without this, a second trigger (another token
    // change, or a refocus) arriving before the pulsed attempt opens would pulse AGAIN
    // mid-backoff - the exact stale-timer/thundering-herd case the comment above warns about.
    reconnectExhaustedRef.current = false;
    setForceDisconnected(true);
  }, []);

  const readyStateRef = useRef(readyState);
  useEffect(() => {
    readyStateRef.current = readyState;
  }, [readyState]);

  // A socket can read OPEN while the connection underneath is dead (laptop sleep, network
  // change): the library's heartbeat only notices a full timeout window later, so Send looks
  // ready for up to ~2 minutes while frames go nowhere. On a wake-up signal, ping now and, if
  // nothing at all comes back, drop the connection so it reconnects immediately. The gate is
  // untouched while the probe is out - readyState only moves if the socket is actually dropped.
  // A dead OPEN socket has no pending backoff timer, so this pulse can't cancel one; and it
  // doesn't touch reconnectExhaustedRef, which only describes a closed socket.
  const probeLiveness = useCallback(() => {
    if (readyStateRef.current !== ReadyState.OPEN || probeTimerRef.current) return;
    const sentAt = Date.now();
    if (sentAt - lastProbeAtRef.current < LIVENESS_PROBE_DEBOUNCE_MS) return;
    lastProbeAtRef.current = sentAt;
    sendMessage(HEARTBEAT_MESSAGE, false);
    probeTimerRef.current = setTimeout(() => {
      probeTimerRef.current = null;
      if (lastMessageAtRef.current >= sentAt || readyStateRef.current !== ReadyState.OPEN) return;
      console.log('ws liveness probe got no reply; reconnecting');
      // share: true hands out a proxy that refuses close(), so drop it the same way the
      // reconnect pulse does: a momentary null url tears the shared socket down.
      setForceDisconnected(true);
    }, LIVENESS_PROBE_TIMEOUT_MS);
  }, [sendMessage]);

  useEffect(() => {
    return () => {
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      pulseReconnect();
      probeLiveness();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);
    window.addEventListener('online', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
      window.removeEventListener('online', handleVisibility);
    };
  }, [pulseReconnect, probeLiveness]);

  // Sleep detector: timers freeze while the machine sleeps, so a tick landing far later than
  // scheduled means it woke - which fires no focus event when the tab was already focused.
  useEffect(() => {
    let lastTickAt = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const slept = now - lastTickAt > SLEEP_CHECK_INTERVAL_MS + SLEEP_GAP_THRESHOLD_MS;
      lastTickAt = now;
      if (slept) probeLiveness();
    }, SLEEP_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [probeLiveness]);

  // Catch-up after a reconnect: frames sent while the socket was down are gone for good, so
  // refetch the quest lists on screen once (active queries only). An incomplete turn then
  // resolves from the refreshed cache via useStreamingMessageMerge, which works even for a new
  // notebook's first turn. Skipped for the first connect, which has nothing to catch up.
  const hasOpenedRef = useRef(false);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = readyState === ReadyState.OPEN;
    if (isOpen && !wasOpenRef.current && hasOpenedRef.current) {
      void queryClient.invalidateQueries({ queryKey: ['quests', 'session'] });
    }
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  // A token refresh alone changes the socket's queryParams (a new url -> a brand new
  // WebSocket, per create-or-join.ts's per-url sharedWebSockets map) but never resets the
  // library's own reconnectCount - so once the budget is exhausted, the fresh connection gets
  // exactly one attempt and immediately re-exhausts, forever, with no focus event to save it.
  // That's the focused-tab gap: nothing ever blurs, so the visibilitychange pulse above never
  // fires. Treat a post-exhaustion token change as the second trigger for the same pulse.
  // prevAccessTokenRef skips the mount's own token (nothing has exhausted yet at mount).
  const prevAccessTokenRef = useRef(accessToken);
  useEffect(() => {
    const changed = prevAccessTokenRef.current !== accessToken;
    prevAccessTokenRef.current = accessToken;
    if (!changed) return;
    pulseReconnect();
  }, [accessToken, pulseReconnect]);

  // Third trigger, and the only self-armed one. Both triggers above are external events, and a
  // tab that stays focused while its access token is still valid produces neither: no
  // focus/visibilitychange ever fires, and the exhausting attempt's own /api/identify probe
  // returns the SAME token, which changes nothing for the effect above. Such a tab's socket
  // stayed dead until its token happened to rotate - up to 30 minutes of failed pushes after a
  // ~6-minute budget ran out. This tick closes that gap by re-running the same pulse on a
  // timer, inheriting both of its safety properties: the flag is only set once nothing is
  // pending (so a healthy jittered backoff is never cancelled) and is cleared as the pulse
  // fires (so one exhaustion yields one pulse, never a herd). Hidden tabs are skipped because
  // a return to visible already pulses - no reason to spend the one pulse per budget on a tab
  // nobody is looking at.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      pulseReconnect();
    }, EXHAUSTED_RETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pulseReconnect]);

  // The other half of the pulse: flip back on the next commit so shouldConnect's dip to
  // false was only momentary - enough for react-use-websocket to see url turn null (see
  // the DEFAULT_RECONNECT_LIMIT comment above) and reset before reconnecting.
  useEffect(() => {
    if (forceDisconnected) setForceDisconnected(false);
  }, [forceDisconnected]);

  const subscribeToAction = useCallback(
    (action: IMessageDataToClient['action'], callback: (message: IMessageDataToClient) => Promise<void>) => {
      const actionListeners = listeners.current.get(action) ?? [];
      listeners.current.set(action, [...actionListeners, callback]);
      return () => {
        if (didUnmount.current) return;
        const actionListeners = listeners.current.get(action) ?? [];
        listeners.current.set(
          action,
          actionListeners.filter(listener => listener !== callback)
        );
      };
    },
    []
  );

  const trackedSendJsonMessage = useCallback(
    (action: IMessageDataToServer) => {
      if (action.action === 'subscribe_query') {
        setActiveSubscriptions(prev => {
          if (prev.has(action.subscriptionId)) return prev;
          const next = new Set(prev);
          next.add(action.subscriptionId);
          return next;
        });
      } else if (action.action === 'unsubscribe_query') {
        setActiveSubscriptions(prev => {
          if (!prev.has(action.subscriptionId)) return prev;
          const next = new Set(prev);
          next.delete(action.subscriptionId);
          return next;
        });
      }
      sendJsonMessage({ ...action, accessToken });
    },
    [sendJsonMessage, accessToken]
  );

  const value: WebsocketContextValue = useMemo(() => {
    return {
      sendJsonMessage: trackedSendJsonMessage,
      subscribeToAction,
      resetLastJsonMessage,
      readyState: readyState,
      activeSubscriptions,
      clientId,
    };
  }, [readyState, trackedSendJsonMessage, subscribeToAction, resetLastJsonMessage, activeSubscriptions, clientId]);

  // Dev-only: expose `sendJsonMessage` on window for forging messages from
  // the browser console. Used to test cc_agent_register before the bridge
  // binary was downloadable. Guarded *both* on build mode and host so a
  // preview/staging build (NODE_ENV=production but URL is not prod) can't
  // accidentally expose it - and so running the prod bundle locally
  // against localhost doesn't either.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (process.env.NODE_ENV === 'production') return;
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    if (!isLocal) return;
    (window as unknown as { __b4mSend?: WebsocketContextValue['sendJsonMessage'] }).__b4mSend = value.sendJsonMessage;
    return () => {
      delete (window as unknown as { __b4mSend?: unknown }).__b4mSend;
    };
  }, [value.sendJsonMessage]);

  return <WebsocketContext.Provider value={value}>{children}</WebsocketContext.Provider>;
};
