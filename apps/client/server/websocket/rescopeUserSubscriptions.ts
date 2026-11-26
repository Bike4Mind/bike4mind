import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { realtimeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { closeConnection } from '@bike4mind/server-utils/websocket/closeConnection';
import { sendToConnection } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';

/**
 * After access is removed, drop the users' live query subscriptions and tell each socket to
 * re-subscribe, so every scope is rebuilt against current access (same handshake as
 * reauthConnection.ts). Run after the revoke commits. Best-effort: never throws.
 */
export async function rescopeUserSubscriptions(userIds: readonly string[], logger?: Logger): Promise<void> {
  const log = logger ?? Logger.globalInstance;
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  let connectionIds: string[];
  let endpoint: string;
  try {
    endpoint = Resource.websocket.managementEndpoint;
    connectionIds = await realtimeConnectionRepository.dropUserSubscriptions(ids);
  } catch (error) {
    log.warn('[rescopeUserSubscriptions] Failed to drop subscriptions', { userIds: ids, error });
    return;
  }
  await Promise.all(
    connectionIds.map(async connectionId => {
      try {
        await sendToConnection(connectionId, endpoint, { action: 'resubscribe_required' });
      } catch (error) {
        if (error instanceof GoneException) return;
        // A socket that never hears this would sit silent; closing it makes the client reconnect.
        log.warn(`[rescopeUserSubscriptions] Failed to notify ${connectionId}`, error as Error);
        await realtimeConnectionRepository.endConnections({ connectionIds: [connectionId] }).catch(() => undefined);
        await closeConnection(connectionId, endpoint).catch(() => undefined);
      }
    })
  );
}
