import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { MeResponseSchema } from '../../schemas/me';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * The caller's own identity and commercial state.
 *
 * Exists because an app built on B4M had no supported way to ask whether its user
 * can afford the next call: balance and entitlements were reachable only from
 * uncontracted internal routes, and tier was not exposed at all. The nearest thing
 * integrators reached for, `/api/identify`, returns the whole user document AND
 * issues a browser session as a side effect - which is why this is a new endpoint
 * rather than a contract wrapped around that one.
 *
 * Purely additive: the internal `/api/credits/balance` and `/api/entitlements`
 * routes keep serving the SPA unchanged.
 */
export const getMeContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/me',
  operationId: 'getMe',
  summary: 'Get the authenticated caller',
  description:
    'Returns the authenticated caller: stable id, display name, plan tier, personal credit balance, ' +
    'and entitlement keys. The subject is always the credential holder - this endpoint accepts no ' +
    'user id, owner id, or impersonation parameter of any kind, so a key can only ever read its own ' +
    "owner. `credits.balance` is the caller's personal ledger; a call billed to an organization draws " +
    'on a pool this number does not describe. Gate on `tier != "free"` for "is this caller paying" and ' +
    'on `subscription.price_id` for which product - the `basic`/`pro` rungs come from an internal plan ' +
    'ladder and do not track a plan\'s marketing name. Responses are never cacheable. Authenticate with ' +
    'an API key (`b4m_live_`) carrying `me:read`, or a JWT.',
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.ME_READ],
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The caller, their tier, their personal credit balance, and their entitlement keys.',
      schema: MeResponseSchema,
      example: {
        id: '507f1f77bcf86cd799439011',
        name: 'Ada Lovelace',
        tier: 'basic',
        subscription: {
          plan_name: 'Professional',
          price_id: 'price_123',
          interval: 'monthly',
          current_period_ends_at: '2026-10-18T00:00:00.000Z',
        },
        credits: { balance: 31667 },
        entitlements: ['base'],
      },
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});
