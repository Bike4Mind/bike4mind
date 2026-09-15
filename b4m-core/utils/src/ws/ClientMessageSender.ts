import { IConnection, MessageDataToClient } from '@bike4mind/common';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { sendToConnection } from './utils';

export class ClientMessageSender {
  // Cache connections to avoid a database query on every send.
  private connectionCache = new Map<string, { connections: IConnection[]; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 seconds
  private readonly MAX_CACHE_ENTRIES = 1000; // Bound cache size to prevent memory leaks

  constructor(
    private db: {
      connections: {
        findByUserId(userId: string): Promise<IConnection[]>;
        deleteByConnectionId(connectionId: string): Promise<void>;
      };
    },
    private logger: Logger
  ) {}

  private async getConnections(userId: string): Promise<IConnection[]> {
    const now = Date.now();
    const cached = this.connectionCache.get(userId);

    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.connections;
    }

    // Drop the expired entry.
    if (cached) {
      this.connectionCache.delete(userId);
    }

    // Occasional cleanup (1% chance).
    if (Math.random() < 0.01) {
      this.cleanupExpiredEntries();
    }

    const connections = await this.db.connections.findByUserId(userId);
    this.connectionCache.set(userId, { connections, timestamp: now });

    return connections;
  }

  private invalidateConnectionCache(userId: string, connectionId: string): void {
    const cached = this.connectionCache.get(userId);
    if (cached) {
      // Remove the failed connection from cache
      cached.connections = cached.connections.filter(conn => conn.connectionId !== connectionId);
      // If no connections left, remove the cache entry
      if (cached.connections.length === 0) {
        this.connectionCache.delete(userId);
      }
    }
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    for (const [userId, entry] of Array.from(this.connectionCache.entries())) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.connectionCache.delete(userId);
      }
    }

    // Emergency cleanup if still too large
    if (this.connectionCache.size > this.MAX_CACHE_ENTRIES) {
      const entries = Array.from(this.connectionCache.entries());
      entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);
      const toDelete = entries.slice(0, this.connectionCache.size - this.MAX_CACHE_ENTRIES);
      toDelete.forEach(([userId]) => this.connectionCache.delete(userId));
    }
  }

  async sendToClient(userId: string, endpoint: string, action: z.infer<typeof MessageDataToClient>): Promise<void> {
    const connections = await this.getConnections(userId);

    const sendResults = await Promise.allSettled(
      connections.map(connection => sendToConnection(connection.connectionId, endpoint, action))
    );

    await Promise.allSettled(
      sendResults.map((result, index) => {
        if (result.status === 'rejected') {
          const connection = connections[index];
          this.logger.info(`Failed to send message to connection ${connection.connectionId}: ${result.reason.message}`);
          this.logger.log(`Deleting connection ${connection.connectionId}`);

          // Drop the failed connection from the cache.
          this.invalidateConnectionCache(userId, connection.connectionId);

          return this.db.connections.deleteByConnectionId(connection.connectionId);
        }
      })
    );
  }

  // For other parts of the system to invalidate cache
  public invalidateUserConnections(userId: string): void {
    this.connectionCache.delete(userId);
  }
}
