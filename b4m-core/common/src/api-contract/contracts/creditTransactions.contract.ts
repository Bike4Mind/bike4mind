import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  ListCreditTransactionsQuerySchema,
  ListCreditTransactionsResponseSchema,
} from '../../schemas/creditTransaction';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/** Contract for GET /api/v1/credits/transactions, served by apps/client/pages/api/v1/credits/transactions.ts. */
export const listCreditTransactionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/credits/transactions',
  operationId: 'listCreditTransactions',
  summary: "List the caller's credit transactions",
  description:
    "Lists the authenticated caller's credit ledger, newest first: purchases, subscription grants and " +
    'spend, each with a signed `credits` amount. Covers the personal ledger only (the same one ' +
    '`GET /api/v1/credits` reports); organization pools are not included. Limited to the last `days` ' +
    '(default 30, at most 365) and filterable to credits `added` or `deducted`. Cursor-paginated (see the ' +
    'pagination convention): pass `next_cursor` back as `cursor` until it is `null`. Changing `days` or ' +
    '`type` starts a new listing, so drop the cursor when you do. The subject is always the credential ' +
    'holder; this endpoint accepts no user or owner id. Responses are never cacheable. An API key needs ' +
    "`me:read`, the scope that opens the rest of the caller's commercial state.",
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  // me:read only, unlike the balance route: spend history is account detail, not the pre-flight number an AI key needs.
  scopes: [ApiKeyScope.ME_READ],
  queryParams: ListCreditTransactionsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of transactions, newest first.', schema: ListCreditTransactionsResponseSchema },
    403: { description: 'The API key does not hold `me:read`.', schema: ScopeForbiddenErrorSchema },
    422: {
      description:
        '`limit`, `days` or `type` is out of range, or `cursor` is malformed or was issued by a different ' +
        'endpoint. A cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
