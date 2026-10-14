import { Logger } from '@bike4mind/observability';
import { IRealtimeConnectionRepository, RealtimeConnectionFilter } from '@bike4mind/common';

export interface EndRealtimeConnectionsAdapters {
  db: { realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'> };
  logger?: Logger;
}

/**
 * End the realtime connections a revoke makes stale: their QuerySubscription entries are pulled
 * (so they stop receiving pushes) and their Connection rows are marked ended, not deleted. An ended
 * row no longer authorizes the connection-only WS actions, and it stays so the realtime sweep can
 * close the socket and then delete the row. DB-only; needs no WebSocket permission. Called from
 * inside every revoke primitive (revokeSession, revokeAllUserSessions, revokeUserSessions, account
 * block, user delete, API key revoke/rotate) so a caller cannot revoke a credential and leave its
 * socket live.
 *
 * Never throws: the revoke it rides on has already happened and must keep its outcome, so a
 * failure here is logged and the sweep (which also ends connections whose credential lapsed)
 * backstops it. Returns the ended connection ids, or [] on failure. The repository's writes never
 * join a caller's transaction, so a caller inside withTransaction is not aborted by a failure here.
 */
export const endRealtimeConnections = async (
  filter: RealtimeConnectionFilter,
  { db, logger }: EndRealtimeConnectionsAdapters
): Promise<string[]> => {
  try {
    const { connectionIds } = await db.realtimeConnections.endConnections(filter);
    if (connectionIds.length > 0) logger?.log('Ended', connectionIds.length, 'realtime connection(s)');
    return connectionIds;
  } catch (error) {
    const message = 'Failed to end realtime connections; the sweep will retry';
    if (logger) logger.warn(message, error as Error);
    else console.warn(message, error);
    return [];
  }
};
