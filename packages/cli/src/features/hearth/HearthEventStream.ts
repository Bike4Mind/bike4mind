import type { WebSocketConnectionManager } from '../../ws/WebSocketConnectionManager.js';
import type { HearthEvent } from './types.js';
import { HearthEventSchema } from './types.js';

/**
 * Subscribes to `hearth_event` WebSocket events and forwards parsed
 * events to a callback (same fanout path Tavern uses for its heartbeat log).
 *
 * Owned by HearthModule - registered/disposed through the module lifecycle.
 */
export class HearthEventStream {
  private wsManager: WebSocketConnectionManager | null = null;

  constructor(private readonly onEvent: (event: HearthEvent) => void) {}

  /** Register the WS handler for hearth_event messages */
  registerHandlers(wsManager: WebSocketConnectionManager): void {
    // Dispose existing handlers first to prevent duplicates during hot-reload
    this.dispose();

    this.wsManager = wsManager;

    wsManager.onAction('hearth_event', (message: unknown) => {
      const parsed = message as { event?: unknown };
      if (!parsed.event) return;

      const result = HearthEventSchema.safeParse(parsed.event);
      if (result.success) {
        this.onEvent(result.data);
      }
    });
  }

  /** Unsubscribe from WS events */
  dispose(): void {
    if (this.wsManager) {
      this.wsManager.offAction('hearth_event');
      this.wsManager = null;
    }
  }
}
