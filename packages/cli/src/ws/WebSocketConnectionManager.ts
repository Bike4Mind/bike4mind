import WsWebSocket from 'ws';
import { logger } from '../utils/Logger';

// True when we must use the `ws` npm package (Node 20 has no built-in WebSocket).
const useWsPolyfill = typeof globalThis.WebSocket === 'undefined';

// For readyState comparisons and the general type we still reference the `ws` class.
const WS: typeof WebSocket = useWsPolyfill ? (WsWebSocket as unknown as typeof WebSocket) : globalThis.WebSocket;

/** Callback for incoming WebSocket messages routed by requestId */
type MessageHandler = (message: Record<string, unknown>) => void;

/** Callback invoked when the WebSocket connection drops */
type DisconnectHandler = () => void;

/** Function that returns the current access token (JWT or API key) */
type TokenGetter = () => Promise<string | null>;

/**
 * Manages a persistent WebSocket connection for CLI <-> server communication.
 * Handles heartbeat, reconnection, and message routing by requestId.
 *
 * Uses Node.js built-in WebSocket (Node 22+) with `ws` package fallback for Node 20.
 */
export class WebSocketConnectionManager {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private getToken: TokenGetter;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private handlers = new Map<string, MessageHandler>();
  private actionHandlers = new Map<string, MessageHandler>();
  private disconnectHandlers = new Set<DisconnectHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private connecting = false;
  private closed = false;

  constructor(wsUrl: string, getToken: TokenGetter) {
    this.wsUrl = wsUrl;
    this.getToken = getToken;
  }

  /**
   * Connect to the WebSocket server.
   * Resolves when connection is established, rejects on failure.
   */
  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    const token = await this.getToken();
    if (!token) {
      this.connecting = false;
      throw new Error('No access token available for WebSocket connection');
    }

    return new Promise<void>((resolve, reject) => {
      logger.debug(`[WS] Connecting to ${this.wsUrl}...`);

      // Pass token via Sec-WebSocket-Protocol header instead of URL query param
      // to avoid token exposure in proxy logs and server access logs.
      //
      // The `ws` npm package (Node 20 polyfill) is stricter than the browser API:
      // if you pass protocols, it requires the server to echo one back. API Gateway
      // doesn't do that. So for `ws` we send the header manually via `options.headers`
      // which still sets the Sec-WebSocket-Protocol request header but doesn't enforce
      // a server response.
      if (useWsPolyfill) {
        this.ws = new WsWebSocket(this.wsUrl, {
          headers: { 'Sec-WebSocket-Protocol': `access_token.${token}` },
        }) as unknown as WebSocket;
      } else {
        this.ws = new WS(this.wsUrl, [`access_token.${token}`]);
      }

      this.ws.onopen = () => {
        logger.debug('[WS] Connected');
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const message = JSON.parse(data) as Record<string, unknown>;
          const requestId = message.requestId as string | undefined;

          if (requestId && this.handlers.has(requestId)) {
            this.handlers.get(requestId)!(message);
          } else {
            // Check action-based handlers (e.g. keep_command from server relay)
            const action = message.action as string | undefined;
            if (action && this.actionHandlers.has(action)) {
              this.actionHandlers.get(action)!(message);
            } else {
              logger.debug(`[WS] Unhandled message: ${action || 'unknown'}`);
            }
          }
        } catch (err) {
          logger.debug(`[WS] Failed to parse message: ${err}`);
        }
      };

      this.ws.onclose = () => {
        logger.debug('[WS] Connection closed');
        this.cleanup();
        this.notifyDisconnect();
        if (!this.closed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err: Event) => {
        // `ws` package attaches the underlying Error to the event
        const underlying = (err as Event & { error?: Error }).error;
        const detail = underlying?.message || String(err);
        logger.debug(`[WS] Error: ${detail}`);
        if (this.connecting) {
          this.connecting = false;
          this.connected = false;
          reject(new Error(`WebSocket connection failed: ${detail}`));
        }
      };
    });
  }

  /** Whether the connection is currently established */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a JSON message over the WebSocket connection.
   */
  send(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WS.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const payload = JSON.stringify(data);
    const sizeKB = (payload.length / 1024).toFixed(1);
    logger.debug(`[WS] Sending ${sizeKB} KB (action: ${data.action as string})`);
    if (payload.length > 32_000) {
      logger.warn(`[WS] Payload ${sizeKB} KB exceeds API Gateway 32 KB frame limit — connection will be closed`);
    }
    this.ws.send(payload);
  }

  /**
   * Register a handler for messages matching a specific requestId.
   */
  onRequest(requestId: string, handler: MessageHandler): void {
    this.handlers.set(requestId, handler);
  }

  /**
   * Remove a handler for a specific requestId.
   */
  offRequest(requestId: string): void {
    this.handlers.delete(requestId);
  }

  /**
   * Register a handler for messages matching a specific action type.
   * Used for server-pushed commands like keep_command.
   */
  onAction(action: string, handler: MessageHandler): void {
    this.actionHandlers.set(action, handler);
  }

  /**
   * Remove a handler for a specific action type.
   */
  offAction(action: string): void {
    this.actionHandlers.delete(action);
  }

  /**
   * Register a handler that fires when the connection drops.
   */
  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.add(handler);
  }

  /**
   * Remove a disconnect handler.
   */
  offDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.delete(handler);
  }

  /**
   * Close the connection and stop all heartbeat/reconnect logic.
   */
  disconnect(): void {
    this.closed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
    this.actionHandlers.clear();
    this.disconnectHandlers.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Send heartbeat every 5 minutes to prevent API Gateway 10-minute idle timeout
    this.heartbeatInterval = setInterval(
      () => {
        if (this.ws && this.ws.readyState === WS.OPEN) {
          this.ws.send(JSON.stringify({ action: 'heartbeat' }));
          logger.debug('[WS] Heartbeat sent');
        }
      },
      5 * 60 * 1000
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private cleanup(): void {
    this.connected = false;
    this.connecting = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyDisconnect(): void {
    for (const handler of this.disconnectHandlers) {
      try {
        handler();
      } catch {
        // Ignore errors from disconnect handlers
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    logger.debug(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed) return;
      try {
        await this.connect();
      } catch {
        logger.debug('[WS] Reconnection failed');
        // onclose will fire again, triggering another reconnect
      }
    }, delay);
  }
}
