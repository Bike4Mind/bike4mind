import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { CreditBalanceSchema } from '../../schemas/creditBalance';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * The caller's spendable balance, and nothing else - the pre-flight check a
 * spend-bearing key needs before it starts a batch.
 *
 * Separate from `GET /api/v1/me` rather than widening its scopes: the OAuth
 * ai-token exchange mints `ai:generate` keys for third-party apps, where `me:read`
 * is consented separately. Accepting `ai:*` on `/me` would hand those apps the
 * user's name, subscription and entitlements; this route discloses only the
 * number they are already spending against.
 */
export const getCreditBalanceContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/credits',
  operationId: 'getCreditBalance',
  summary: "Get the caller's credit balance",
  description:
    "Returns the authenticated caller's spendable credit balance - the same number as `credits.balance` " +
    'on `GET /api/v1/me`, without the identity and plan fields. Use it to check a key can afford a batch ' +
    'before starting one. The subject is always the credential holder; this endpoint accepts no user or ' +
    "owner id. `balance` is the caller's personal ledger; a call billed to an organization draws on a pool " +
    'this number does not describe. Responses are never cacheable. Authenticate with an API key ' +
    '(`b4m_live_`) carrying any one of `me:read`, `ai:chat` or `ai:generate`, or a JWT.',
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.ME_READ, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: "The caller's personal credit balance.",
      schema: CreditBalanceSchema,
      example: { balance: 31667 },
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});
