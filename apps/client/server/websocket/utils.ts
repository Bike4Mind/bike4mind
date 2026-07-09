import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { z } from 'zod';
import { MessageDataToClient } from '@bike4mind/common';
import { Connection } from '@bike4mind/database/social';
import { Logger } from '@bike4mind/observability';
import { Context } from 'aws-lambda';
import { Config } from '@server/utils/config';
import { connectDB } from '@bike4mind/database';
import { contextToLogs } from '@server/utils/logger';
import { JsonWebTokenError } from 'jsonwebtoken';
import { UnauthorizedError } from '@bike4mind/common';

// sendToClient may be called multiple times in a single request,
// so we cache the ApiGatewayManagementApiClient
let apiGatewayManagement: ApiGatewayManagementApiClient;

type PendingUpdate = {
  userId: string;
  endpoint: string;
  data: z.infer<typeof MessageDataToClient>;
};

let lastSentTime = 0;
let pendingUpdate: PendingUpdate | null = null;
const throttleInterval = 10000; // milliseconds

/**
 * Sends a throttled update to a specific WebSocket connection.
 *
 * @param userId - The ID of the user to whom the message will be sent.
 * @param endpoint - The endpoint of the WebSocket API.
 * @param data - The message content, structured according to the MessageDataToClient schema.
 */
export async function sendThrottledUpdate(userId: string, endpoint: string, data: z.infer<typeof MessageDataToClient>) {
  const currentTime = Date.now();
  if (currentTime - lastSentTime >= throttleInterval) {
    await sendToClient(userId, endpoint, data);
    lastSentTime = currentTime;
    pendingUpdate = null;
  } else if (!pendingUpdate) {
    pendingUpdate = { userId, endpoint, data };
    setTimeout(
      async () => {
        if (pendingUpdate) {
          Logger.log(`Sending throttled update to ${pendingUpdate.userId}`);
          await sendToClient(pendingUpdate.userId, pendingUpdate.endpoint, pendingUpdate.data);
          lastSentTime = Date.now();
          pendingUpdate = null;
        }
      },
      throttleInterval - (currentTime - lastSentTime)
    );
  }
}

setInterval(async () => {
  if (pendingUpdate) {
    await sendThrottledUpdate(pendingUpdate.userId, pendingUpdate.endpoint, pendingUpdate.data);
  }
}, throttleInterval);

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

export interface SendToClientOptions {
  /** Filter connections by source (e.g., 'web', 'cli'). If not specified, sends to all connections. */
  sourceFilter?: 'web' | 'cli';
}

/**
 * Sends a message to all WebSocket connections associated with a specific user.
 *
 * @param userId - The ID of the user to whom the message will be sent.
 * @param endpoint - The endpoint of the WebSocket API.
 * @param action - The message content, structured according to the MessageDataToClient schema.
 * @param options - Optional settings for filtering connections.
 */
export async function sendToClient(
  userId: string,
  endpoint: string,
  action: z.infer<typeof MessageDataToClient>,
  options?: SendToClientOptions
) {
  const query: { userId: string; source?: string } = { userId };
  if (options?.sourceFilter) {
    query.source = options.sourceFilter;
  }

  const connections = await Connection.find(query);

  const result = await Promise.allSettled(
    connections.map(connection => sendToConnection(connection.connectionId, endpoint, action))
  );

  await Promise.allSettled(
    result.map((r, i) => {
      if (r.status === 'rejected') {
        const connection = connections[i];
        Logger.info(`Failed to send message to connection ${connection.connectionId}: ${r.reason.message}`);
        // Send failure most likely means the connection is stale; delete it.
        Logger.log(`Deleting connection ${connection.connectionId}`);
        return Connection.deleteOne({ connectionId: connection.connectionId });
      }
    })
  );
}

/**
 * A wrapper function for WebSocket Lambda functions that provides error handling, logging, and database connection.
 * Database connection is enabled by default since most WebSocket handlers require database access.
 *
 * @param handler - The WebSocket Lambda handler function
 * @param options - Configuration options for the wrapper
 * @returns A wrapped handler function with error handling and logging
 */
export function withWebSocketContext<T>(
  handler: (event: T, context: Context, logger: Logger) => Promise<{ statusCode: number; body?: string }>,
  options: {
    skipDatabase?: boolean;
  } = {}
) {
  return async (event: T, context: Context) => {
    const logger = new Logger().withMetadata(contextToLogs(context));

    try {
      if (!options.skipDatabase) {
        await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
      }

      const result = await handler(event, context, logger);
      return result;
    } catch (error) {
      // For WebSocket connections, we should return a 200 status code even for errors
      // to prevent the connection from being terminated, unless it's an authorization error.
      // Detect by TYPE, not by sniffing error.message for "unauthorized" - UnauthorizedError's
      // message is caller-supplied (e.g. connect.ts throws 'Session expired', 'User not found')
      // and never contains that substring, so the old check silently treated every WS auth
      // rejection as a transient error: $connect returned 200, API Gateway accepted the
      // handshake, but Connection.create() had already been skipped by the throw - a "zombie"
      // connection with no DB row and no subscriptions. JsonWebTokenError is included because
      // dataSubscribeRequest.ts/dataUnsubscribeRequest.ts call verifyToken directly with no
      // local try/catch, so a raw jwt error throws (unwrapped) into this same catch. It is the
      // BASE class of TokenExpiredError (expired), NotBeforeError (not-yet-valid), and the
      // signature/malformed errors - all of which are token-validity failures that belong in
      // the 401 bucket - so matching the base covers every jwt rejection in one check.
      const isAuthError = error instanceof UnauthorizedError || error instanceof JsonWebTokenError;

      // Auth rejections are expected, benign, and high-volume (every stale-token client) -
      // log them at info so they don't flood error logs/alerts. Only genuine (non-auth)
      // handler failures are logged at error.
      if (isAuthError) {
        logger.info(`Auth rejected for WebSocket ${context.functionName}: ${(error as Error).message}`);
      } else {
        logger.error(`Error in WebSocket handler ${context.functionName}:`, error);
      }

      return {
        statusCode: isAuthError ? 401 : 200,
        body: JSON.stringify({
          error: isAuthError ? 'Unauthorized' : 'Internal server error',
        }),
      };
    }
  };
}
