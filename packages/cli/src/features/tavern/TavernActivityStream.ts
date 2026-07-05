import type { WebSocketConnectionManager } from '../../ws/WebSocketConnectionManager.js';
import type { HeartbeatLogEntry } from './types.js';
import { HeartbeatLogEntrySchema } from './types.js';

/**
 * Subscribes to `tavern_heartbeat_log` WebSocket events and forwards
 * parsed entries to a callback.
 *
 * Owned by TavernModule - registered/disposed through the module lifecycle.
 */
export class TavernActivityStream {
  private wsManager: WebSocketConnectionManager | null = null;

  constructor(private readonly onLogEntry: (entry: HeartbeatLogEntry) => void) {}

  /** Register the WS handler for tavern_heartbeat_log events */
  registerHandlers(wsManager: WebSocketConnectionManager): void {
    // Dispose existing handlers first to prevent duplicates during hot-reload
    this.dispose();

    this.wsManager = wsManager;

    wsManager.onAction('tavern_heartbeat_log', (message: unknown) => {
      const parsed = message as { entry?: unknown };
      if (!parsed.entry) return;

      const result = HeartbeatLogEntrySchema.safeParse(parsed.entry);
      if (result.success) {
        this.onLogEntry(result.data);
      }
    });
  }

  /** Unsubscribe from WS events */
  dispose(): void {
    if (this.wsManager) {
      this.wsManager.offAction('tavern_heartbeat_log');
      this.wsManager = null;
    }
  }
}
