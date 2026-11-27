import { limitConcurrency } from '@bike4mind/common';
import { realtimeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { closeConnection } from '@bike4mind/server-utils/websocket/closeConnection';
import { Resource } from 'sst';

/** Ends registrations after the access-removal transaction commits; transport failures remain sweepable. */
export async function rescopeUserSubscriptions(userIds: readonly string[], logger?: Logger): Promise<void> {
  const log = logger ?? Logger.globalInstance;
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  const connectionIds = new Set<string>();
  const limit = limitConcurrency(10);
  await Promise.all(
    ids.map(userId =>
      limit(async () => {
        try {
          const ended = await realtimeConnectionRepository.endConnections({ userId });
          ended.connectionIds.forEach(id => connectionIds.add(id));
        } catch (error) {
          log.warn('[rescopeUserSubscriptions] Failed to end registrations', { userId, error });
        }
      })
    )
  );
  if (connectionIds.size === 0) return;
  let endpoint: string;
  try {
    endpoint = Resource.websocket.managementEndpoint;
  } catch (error) {
    log.warn('[rescopeUserSubscriptions] Websocket resource unavailable', { error });
    return;
  }
  await Promise.all(
    [...connectionIds].map(connectionId =>
      limit(async () => {
        try {
          await closeConnection(connectionId, endpoint);
          await realtimeConnectionRepository.deleteEndedConnections([connectionId]);
        } catch (error) {
          log.warn('[rescopeUserSubscriptions] Ended connection retained for sweep', { connectionId, error });
        }
      })
    )
  );
}
