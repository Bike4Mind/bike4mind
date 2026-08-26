import { DataUnsubscribeRequestAction } from '@bike4mind/common';
import { QuerySubscription } from '@bike4mind/database';
import { verifyWsAccessToken } from '@server/websocket/verifyWsAccessToken';
import { withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { Resource } from 'sst';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const endpoint = Resource.websocket.managementEndpoint;
  const connectionId = event.requestContext.connectionId;

  const { accessToken, subscriptionId: clientSubscriberId } = DataUnsubscribeRequestAction.parse(
    JSON.parse(event.body ?? '')
  );

  await verifyWsAccessToken(accessToken);

  // If this was the last subscriber, subscriber-fanout removes the record and drops
  // the change-stream subscription.
  await QuerySubscription.updateOne(
    {
      'subscribers.endpoint': endpoint,
      'subscribers.connectionId': connectionId,
      'subscribers.clientId': clientSubscriberId,
    },
    {
      $pull: {
        subscribers: {
          endpoint,
          connectionId,
          clientId: clientSubscriberId,
        },
      },
    }
  );

  return { statusCode: 200 };
});
