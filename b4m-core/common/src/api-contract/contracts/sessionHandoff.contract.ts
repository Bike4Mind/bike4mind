import { defineEndpoint } from '../defineEndpoint';
import { ApiErrorSchema } from '../../schemas/chat';
import {
  HandoffDevicesResponseSchema,
  SessionHandoffRequestSchema,
  SessionHandoffResponseSchema,
} from '../../schemas/sessionHandoff';

export const listHandoffDevicesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/handoff-devices',
  operationId: 'listHandoffDevices',
  summary: 'List your session handoff destinations',
  description:
    'JWT only. Lists native push devices and authenticated live web/desktop destinations. Web and desktop must stay open to receive a handoff. No push tokens or credentials are returned.',
  tags: ['Account'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your registered destinations.', schema: HandoffDevicesResponseSchema },
    401: { description: 'Sign in again.', schema: ApiErrorSchema },
    429: { description: 'Too many requests.', schema: ApiErrorSchema },
  },
});

export const sendSessionHandoffContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/session-handoffs',
  operationId: 'sendSessionHandoff',
  summary: 'Send a session to one of your devices',
  description:
    'JWT only. Checks normal session read access and destination ownership. Sends only the session identifier, never transcript content or authorization. Native push acceptance is not a delivery receipt; web/desktop delivery requires an open client.',
  tags: ['Account'],
  auth: 'jwtOnly',
  request: SessionHandoffRequestSchema,
  responses: {
    200: { description: 'The handoff was accepted by the transport.', schema: SessionHandoffResponseSchema },
    401: { description: 'Sign in again.', schema: ApiErrorSchema },
    403: { description: 'Session access denied.', schema: ApiErrorSchema },
    404: { description: 'Session or destination unavailable.', schema: ApiErrorSchema },
    409: { description: 'The destination looks inactive. Open it and try again.', schema: ApiErrorSchema },
    429: { description: 'Too many requests.', schema: ApiErrorSchema },
    503: { description: 'Delivery is temporarily unavailable.', schema: ApiErrorSchema },
  },
});
