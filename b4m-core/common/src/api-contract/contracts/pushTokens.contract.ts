import { defineEndpoint } from '../defineEndpoint';
import { PushTokenRegisterRequestSchema, PushTokenUnregisterRequestSchema } from '../../schemas/pushToken';
import { ApiErrorSchema } from '../../schemas/chat';

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token only: the token is bound to the signed-in session that ' +
  'registers it, and API keys have no session. ';

/**
 * Push-token registry for first-party native clients. A token is bound to the registering session
 * and is removed when that session ends (logout, revoke, admin revoke), so a signed-out device
 * stops receiving pushes. Served by apps/client/pages/api/v1/push-tokens.ts.
 */
export const registerPushTokenContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/push-tokens',
  operationId: 'registerPushToken',
  summary: 'Register a device push token',
  description:
    'Registers a push token for the signed-in device so the server can notify it. Idempotent: ' +
    're-registering the same token refreshes it and rebinds it to the calling user and session, ' +
    'which is how a token moves when a different account signs in on the same device. The token ' +
    'is removed automatically when the registering session ends. ' +
    JWT_ONLY_NOTE +
    'A token with no session claim (legacy access token) is refused with `401`; sign in again.',
  tags: ['Account'],
  auth: 'jwtOnly',
  request: PushTokenRegisterRequestSchema,
  requestExample: {
    token: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    kind: 'device',
    platform: 'ios',
    environment: 'production',
    appVersion: '1.0.0',
  },
  responses: {
    204: { description: 'The token is registered.', noBody: true },
    401: { description: 'Missing or invalid JWT, or the token carries no session.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: { token: '<push token>', kind: 'device', platform: 'ios', environment: 'production' },
  },
});

export const unregisterPushTokenContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/push-tokens',
  operationId: 'unregisterPushToken',
  summary: 'Unregister a device push token',
  description:
    'Removes a push token so the server stops notifying it. Succeeds whether or not the token was ' +
    'registered, so a client can call it unconditionally on sign-out. Only the token owner can ' +
    'remove it: a token registered by another user is left in place and the call still succeeds. ' +
    JWT_ONLY_NOTE,
  tags: ['Account'],
  auth: 'jwtOnly',
  request: PushTokenUnregisterRequestSchema,
  requestExample: { token: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
  responses: {
    204: { description: 'The token is not registered (it was removed, or never was).', noBody: true },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: { token: '<push token>' },
  },
});
