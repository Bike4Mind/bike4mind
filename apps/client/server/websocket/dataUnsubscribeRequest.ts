import { DataUnsubscribeRequestAction } from '@bike4mind/common';
import { QuerySubscription, User } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';
import { NotFoundError } from '@server/utils/errors';
import { withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { Resource } from 'sst';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const endpoint = Resource.websocket.managementEndpoint;
  const connectionId = event.requestContext.connectionId;

  const { accessToken, subscriptionId: clientSubscriberId } = DataUnsubscribeRequestAction.parse(
    JSON.parse(event.body ?? '')
  );

  const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
  let previousSecret = undefined;
  // Accept the previous key only within the shared rotation grace window.
  if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt)) {
    previousSecret = secretRotation?.previousKey;
  }
  const decoded = authTokenGenerator.verifyToken(accessToken!, previousSecret) as jwt.JwtPayload;

  const user = await User.findById(decoded.id);
  if (!user) throw new NotFoundError('User not found');

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
