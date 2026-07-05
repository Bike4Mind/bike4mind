import { activeCodeAgentRepository, Connection, QuerySubscription, User, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { sendToClient, withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async function (event, context, logger) {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  // Find the connection to get the userId
  const connection = await Connection.findOne({ connectionId });
  const userId = connection?.userId;

  // Update logout time if a userId was found
  if (userId) {
    // Delete this connection first so the count below excludes it
    await Connection.deleteOne({ connectionId });

    // Only mark user offline if no other connections remain (e.g., CLI + web client both connected)
    const remainingConnections = await Connection.countDocuments({ userId });
    if (remainingConnections === 0) {
      await User.updateOne({ _id: userId }, { lastActiveAt: new Date(), isOnline: false });
      await userService.updateLogoutTime(userId.toString(), { db: { users: userRepository }, logger });
    } else {
      await User.updateOne({ _id: userId }, { lastActiveAt: new Date() });
    }
  }

  // Clean up query subscription subscribers for this connection
  const updatedSubscriptions = await QuerySubscription.updateMany(
    { 'subscribers.connectionId': connectionId },
    { $pull: { subscribers: { connectionId } } }
  );
  console.debug(`Updated ${updatedSubscriptions.modifiedCount} query subscriptions`);

  // Sweep any Claude Code agent sprites owned by this connection and
  // broadcast their despawn to every other tab the user has open.
  //
  // Intentionally NOT gated on canAccessTavern (unlike the inbound Tavern WS
  // action handlers): this is cleanup-only on a closing connection. The records
  // it removes can only exist if a Tavern-authorized user created them
  // (cc_agent_register is gated), the despawn fans out only to that same user's
  // own connections, and cleanup must run regardless of the user's current tag -
  // gating it would leak orphaned sprites if access were revoked mid-session.
  if (userId) {
    const orphanedInstanceIds = await activeCodeAgentRepository.removeByConnectionId(connectionId);
    if (orphanedInstanceIds.length > 0) {
      logger.info(`[DISCONNECT] Swept ${orphanedInstanceIds.length} cc_agent record(s) for connection ${connectionId}`);
      try {
        await sendToClient(userId, endpoint, {
          action: 'tavern_scene_broadcast' as const,
          commands: orphanedInstanceIds.map(instanceId => ({
            type: 'remove_entity' as const,
            id: `cc_agent_${instanceId}`,
          })),
        });
      } catch (err) {
        logger.warn('[DISCONNECT] Failed to broadcast cc_agent removal (non-fatal):', err as Error);
      }
    }
  }

  // Delete connection if not already deleted above (no userId case)
  if (!userId) {
    await Connection.deleteOne({ connectionId });
  }

  return {
    statusCode: 200,
  };
});
