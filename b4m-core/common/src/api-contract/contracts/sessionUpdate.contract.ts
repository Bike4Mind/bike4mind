import { defineEndpoint } from '../defineEndpoint';
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
    '(`b4m_live_`) or a JWT.',
  tags: ['Sessions'],
  auth: 'apiKeyOrJwt',
  pathParams: SessionIdParamSchema,
  request: SessionUpdateRequestSchema,
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
