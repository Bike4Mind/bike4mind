import { Logger } from '@bike4mind/observability';
import { IRealtimeConnectionRepository, RealtimeConnectionFilter } from '@bike4mind/common';

export interface EndRealtimeConnectionsAdapters {
  db: { realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'> };
  logger?: Logger;
}

/**
 * End the realtime connections a revoke makes stale: their QuerySubscription entries stop
 * receiving pushes and their Connection rows are deleted, which also locks the connection-only
 * WS actions. DB-only; the realtime sweep closes the sockets themselves. Called from inside every
 * revoke primitive (revokeSession, revokeAllUserSessions, revokeUserSessions, account block,
 * user delete, API key revoke) so a caller cannot revoke a credential and leave its socket live.
 */
export const endRealtimeConnections = async (
  filter: RealtimeConnectionFilter,
  { db, logger }: EndRealtimeConnectionsAdapters
): Promise<string[]> => {
  const { connectionIds } = await db.realtimeConnections.endConnections(filter);
  if (connectionIds.length > 0) logger?.log('Ended', connectionIds.length, 'realtime connection(s)');
  return connectionIds;
};
