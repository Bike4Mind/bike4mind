import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { MessageDataToClient } from '@bike4mind/common';
import { z } from 'zod';

// sendToClient may be called multiple times in a single request,
// so we cache the ApiGatewayManagementApiClient
let apiGatewayManagement: ApiGatewayManagementApiClient;

/**
 * Sends a message to a specific WebSocket connection.
 *
 * @param connectionId - The ID of the WebSocket connection to send the message to.
 * @param endpoint - The endpoint of the WebSocket API.
 * @param action - The message content, structured according to the MessageDataToClient schema.
 */
export async function sendToConnection(
  connectionId: string,
  endpoint: string,
  action: z.infer<typeof MessageDataToClient>
) {
  apiGatewayManagement ||= new ApiGatewayManagementApiClient({ endpoint });

  await apiGatewayManagement.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(action),
    })
  );
}
