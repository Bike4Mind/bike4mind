import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { withWebSocketContext } from '@bike4mind/server-utils/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(
  async event => {
    const { connectionId, domainName, stage } = event.requestContext;

    const apiGateway = new ApiGatewayManagementApiClient({
      endpoint: `https://${domainName}/${stage}`,
    });

    // Respond to the client with a pong message
    await apiGateway.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: 'pong',
      })
    );

    return {
      statusCode: 200,
    };
  },
  { skipDatabase: true }
);
