import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';

const clients = new Map<string, ApiGatewayManagementApiClient>();

/**
 * Close a WebSocket through the management API (API Gateway, or the self-host ws gateway's
 * DELETE /@connections/{id}). An already-gone connection counts as closed. The caller needs
 * execute-api:ManageConnections on hosted stages.
 */
export async function closeConnection(connectionId: string, endpoint: string): Promise<void> {
  let client = clients.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({ endpoint });
    clients.set(endpoint, client);
  }
  try {
    await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
  } catch (error) {
    if (error instanceof GoneException) return;
    throw error;
  }
}
