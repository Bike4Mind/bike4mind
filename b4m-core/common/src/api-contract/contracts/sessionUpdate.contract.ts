import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { SessionUpdateRequestSchema, SessionIdParamSchema, SessionResponseSchema } from '../../schemas/session';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for PUT /api/sessions/{id}. Single source of truth: the Next.js handler
 * (apps/client/pages/api/sessions/[id]/index.ts) derives its validation from this,
 * and the OpenAPI spec derives the operation from this.
 *
 * This is the call a caller needs to attach knowledge to a session and turn on
 * retrieval - `POST /api/chat`'s `promptMode: "grounded"` reads from the SESSION
 * (knowledgeIds + forceKnowledgeRetrieval set here), not from anything in the chat
 * request body.
 */
export const sessionUpdateContract = defineEndpoint({
  method: 'put',
  path: '/api/sessions/{id}',
  operationId: 'updateSession',
  summary: 'Update a session',
  description:
    'Updates a session (called a "notebook" in the product UI): its name, attached knowledge ' +
    'files, tags, or retrieval settings. Set `knowledgeIds` and `forceKnowledgeRetrieval: true` ' +
    'together to enable grounded retrieval for `POST /api/chat` against this session - retrieval ' +
    'is gated by these session fields, not by the chat request. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT. Warning: adding to `knowledgeIds` shares those files with every ' +
    'member of every project containing this session by default (see `propagateToProjects`), ' +
    'and that sharing cannot be undone through the UI.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  // Scopes are API-key-only (apiKeyAuth's gate never runs for JWT/browser callers, so the
  // product's own session-rename UI is unaffected). WRITE_NOTEBOOKS is deliberately the ONLY
  // scope here - narrow-purpose keys like CC_BRIDGE/EMBED_CHAT must NOT be added as
  // alternatives: both are documented elsewhere as intentionally narrow-blast-radius
  // credentials (EMBED_CHAT in particular never even carries a sessionId today), and OR-ing
  // them in here would authorize them for session rewrites + the propagateToProjects sharing
  // side effect, which is the exact gap this scope closes, not something to reopen.
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: SessionIdParamSchema,
  request: SessionUpdateRequestSchema,
  // Served by baseApi (via nextRouteForContract), so the apiKeyRateLimit middleware
  // sets the windowed X-RateLimit-* headers on every API-key-authenticated response.
  emitsRateLimitHeaders: true,
  requestExample: { knowledgeIds: ['<fabFileId>'], forceKnowledgeRetrieval: true },
  responses: {
    200: { description: 'The updated session.', schema: SessionResponseSchema },
    404: { description: 'No session exists with the given id.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { knowledgeIds: ['<fabFileId>'], forceKnowledgeRetrieval: true },
  },
});
