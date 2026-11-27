import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

/**
 * Send an untyped JSON payload to a WebSocket connection.
 * Agent execution events use their own action schema (not MessageDataToClient)
 * since they're consumed by dedicated client-side agent execution handlers.
 */
export async function sendAgentEvent(
  connectionId: string,
  endpoint: string,
  payload: Record<string, unknown>
): Promise<void> {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  await client.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(payload)),
    })
  );
}
