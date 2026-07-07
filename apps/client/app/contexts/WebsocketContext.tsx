import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ReadyState, useBaseWebsocket } from 'react-use-websocket';
import { HeartbeatAction, IMessageDataToClient, IMessageDataToServer } from '@bike4mind/common';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api, isPublicPath } from '@client/app/contexts/ApiContext';

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

interface Props {
  children: React.ReactNode;
  url?: string;
}

export const WebsocketProvider = ({ children, url }: Props) => {
  const didUnmount = useRef(false);
  const setLastJsonMessage = useLastJsonMessage(useShallow(s => s.setLastJsonMessage));
  const accessToken = useAccessToken(useCallback(state => state.accessToken, []));
  // True once `onOpen` has fired for the CURRENT connect attempt; reset on each close.
  // Mirrors the same flag in the CLI's WebSocketConnectionManager.
  const openedThisAttemptRef = useRef(false);
  // Single-flight guard so a burst of close events fires at most one auth probe.
  const probeInFlightRef = useRef(false);

  // Map the action being listened for to the callbacks that want to hear about it
  const listeners = useRef(new Map<string, ((message: IMessageDataToClient) => Promise<void>)[]>());

  const [activeSubscriptions, setActiveSubscriptions] = useState<ReadonlySet<string>>(() => new Set());
  const [clientId] = useState(() => crypto.randomUUID().slice(0, 8));

  // Only connect when we have both a valid URL and access token
  // URL validation guards against build-time env vars that were undefined
  const shouldConnect = !!accessToken && isValidWebsocketUrl(url);

  const { sendJsonMessage, readyState } = useBaseWebsocket(shouldConnect ? url : null, {
    queryParams: { token: accessToken as string },
    shouldReconnect: () => !didUnmount.current,
    retryOnError: true,
    share: true,
    heartbeat: {
      message: JSON.stringify(HeartbeatAction?.parse({ action: 'heartbeat' })),
      returnMessage: 'pong',
      timeout: 60000, // 1 minute, if no response is received, the connection will be closed
      interval: 15000, // every 15 seconds, a ping message will be sent
    },
    // Quadratic backoff + random jitter so all clients don't reconnect in a synchronized
    // thundering herd after a deploy or network blip. Without jitter, 400 users reconnect
    // at the same instant and flood subscribe_query Lambdas simultaneously.
    reconnectInterval: i => 125 * (i + 1) ** 2 + Math.random() * 1000,
    onOpen: () => {
      console.log('ws connected');
      openedThisAttemptRef.current = true;
    },
    onClose(event: CloseEvent) {
      console.log('ws disconnected', event.code, event.reason);
      const openedThisAttempt = openedThisAttemptRef.current;
      openedThisAttemptRef.current = false;

      if (
        !probeInFlightRef.current &&
        shouldProbeOnFailedWsConnect({
          openedThisAttempt,
          accessToken,
          mfaPending: useAccessToken.getState().mfaPending,
          pathname: window.location.pathname,
        })
      ) {
        probeInFlightRef.current = true;
        // A connect ATTEMPT just failed to open while holding a token - the closest signal
        // to "the server rejected this connection" a WS close can carry. Fire one authed
        // request through `api` and let its existing 401 interceptor (ApiContext) do the
        // work: refresh -> forceSessionExpiredRedirect on a genuine revocation, or nothing
        // on a network error (WS keeps retrying on its own backoff either way).
        api
          .get('/api/identify')
          .catch(() => {})
          .finally(() => {
            probeInFlightRef.current = false;
          });
      }
    },
    onReconnectStop(numAttempts) {
      console.log('ws reconnect stopped after', numAttempts, 'attempts');
    },

    onMessage: event => {
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
