import { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';

/**
 * WebSocket $default route handler.
 *
 * Catches all messages that don't match a dedicated route key.
 * Also dispatches Keep command actions as a fallback - API Gateway
 * only routes to dedicated handlers once their routes are deployed
 * via CloudFormation, so this ensures Keep commands work immediately
 * during local development even before `sst dev` deploys the new routes.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event, context) => {
  let parsedAction: string | undefined;
  try {
    const parsed = JSON.parse(event.body ?? '{}');
    parsedAction = parsed.action;
  } catch {
    /* body isn't valid JSON */
  }

  // Dispatch Keep actions to their handlers (fallback until dedicated routes are deployed)
  if (parsedAction === 'keep_command_request') {
    const { func } = await import('./keepCommandRequest');
    return func(event, context);
  }
  if (parsedAction === 'keep_command_response') {
    const { func } = await import('./keepCommandResponse');
    return func(event, context);
  }

  console.warn(`[WS $default] Unrouted message — action="${parsedAction || 'NONE'}"`, {
    action: parsedAction,
    bodyPreview: (event.body ?? '').substring(0, 200),
    connectionId: event.requestContext?.connectionId,
    routeKey: event.requestContext?.routeKey,
  });

  return { statusCode: 200 };
};
