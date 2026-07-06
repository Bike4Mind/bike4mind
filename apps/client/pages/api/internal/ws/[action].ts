import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { func as connectFunc } from '@server/websocket/connect';
import { func as disconnectFunc } from '@server/websocket/disconnect';
import { func as subscribeFunc } from '@server/websocket/dataSubscribeRequest';
import { func as unsubscribeFunc } from '@server/websocket/dataUnsubscribeRequest';
import type { Context } from 'aws-lambda';
import { Resource } from 'sst';

/**
 * Self-host WebSocket handler bridge.
 *
 * In AWS, API Gateway invokes the connect/subscribe/unsubscribe/disconnect
 * Lambda handlers directly. In self-host there is no API Gateway: the `ws`
 * gateway (selfhost/ws-gateway) owns the raw browser sockets + the management
 * endpoint, and delegates the actual handler logic here over an internal,
 * shared-secret HTTP call. Reusing the existing `func`s keeps JWT verification
 * and CASL query-scoping identical to the hosted path.
 *
 * This route is self-host only and guarded by INTERNAL_WS_SECRET; it is never
 * reachable in the AWS deployment (the gateway that calls it doesn't exist there).
 */

// The handlers only read `functionName` off the Lambda context; stub the rest.
function lambdaContext(functionName: string): Context {
  return { functionName, callbackWaitsForEmptyEventLoop: false } as unknown as Context;
}

const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req, res) => {
    if (process.env.B4M_SELF_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }

    // Shared-secret guard (mirrors pages/api/test/cleanup.ts). The ws gateway
    // sends this header; browsers cannot (they never learn the secret).
    const expected = process.env.INTERNAL_WS_SECRET;
    const provided = req.headers['x-internal-ws-secret'];
    if (!expected || provided !== expected) {
      return res.status(401).json({ error: 'Invalid internal ws secret' });
    }

    const action = String((req.query as { action?: string }).action ?? '');
    const { connectionId, token, headers, body } = (req.body ?? {}) as {
      connectionId?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    if (!connectionId) {
      return res.status(400).json({ error: 'connectionId required' });
    }

    if (action === 'connect') {
      const event = {
        requestContext: { connectionId },
        queryStringParameters: token ? { token } : {},
        headers: headers ?? {},
      };
      const result = await connectFunc(event as never, lambdaContext('selfhost_ws_connect'));
      return res.status(result.statusCode).json(result);
    }

    if (action === 'disconnect') {
      // domainName/stage only feed disconnect's best-effort cc_agent despawn
      // broadcast; the core cleanup (Connection + QuerySubscription pull) ignores
      // them. Derive them from the management endpoint so the URL is at least
      // pointed at the gateway.
      const mgmt = new URL(Resource.websocket.managementEndpoint);
      const event = {
        requestContext: {
          connectionId,
          domainName: mgmt.host,
          stage: mgmt.pathname.replace(/^\//, ''),
        },
      };
      const result = await disconnectFunc(event as never, lambdaContext('selfhost_ws_disconnect'));
      return res.status(result.statusCode).json(result);
    }

    if (action === 'message') {
      let parsedAction: string | undefined;
      try {
        parsedAction = JSON.parse(body ?? '{}').action;
      } catch {
        /* non-JSON frame */
      }
      const event = { requestContext: { connectionId }, body };

      if (parsedAction === 'subscribe_query') {
        const result = await subscribeFunc(event as never, lambdaContext('selfhost_ws_subscribe'));
        return res.status(result.statusCode).json(result);
      }
      if (parsedAction === 'unsubscribe_query') {
        const result = await unsubscribeFunc(event as never, lambdaContext('selfhost_ws_unsubscribe'));
        return res.status(result.statusCode).json(result);
      }
      // Unrouted action: ack (mirrors the $default WS route) so the gateway
      // doesn't treat it as an error. Extend here for other inbound actions.
      return res.status(200).json({ statusCode: 200, ignored: parsedAction ?? null });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  })
);

export default handler;
