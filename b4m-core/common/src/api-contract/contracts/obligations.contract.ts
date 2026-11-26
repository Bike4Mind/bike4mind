import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  ListObligationsQuerySchema,
  ListObligationsResponseSchema,
  ObligationHandoffRequestSchema,
  ObligationIdParamSchema,
  ObligationSchema,
  ObligationUpdateRequestSchema,
} from '../../schemas/obligation';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Obligations: a scanned bill, receipt or letter handed to the assistant. Served by
 * apps/client/pages/api/v1/obligations/index.ts (hand-off, list) and [id].ts (read, correct + confirm);
 * the extraction lives in apps/client/server/obligations/handOffDocument.ts and confirmed ones reach
 * the brief through apps/workers/src/events/briefCompose.ts.
 */
const SCOPES = [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE];
const RATE_LIMITED = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };
const CONNECTED_APP = {
  description: 'The key was minted for a connected app, which cannot use obligations.',
  schema: ApiErrorSchema,
};
const NOT_FOUND = { description: 'No such obligation, or it is not yours.', schema: ApiErrorSchema };

const OBLIGATION_EXAMPLE = {
  id: 'obligation_example',
  status: 'pending' as const,
  document_kind: 'invoice' as const,
  file_id: 'file_example',
  amount: { value: 120.5, currency: 'USD' },
  payee: 'Example Utilities',
  due_date: '2026-12-15',
  destination: { lake_id: 'lake_example', name: 'Household bills' },
  summary: 'Electricity bill for November.',
  created_at: '2026-11-25T10:00:00.000Z',
  confirmed_at: null,
};

export const handOffObligationContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/obligations',
  operationId: 'handOffObligation',
  summary: 'Hand a scanned document to the assistant',
  description:
    'Reads a document you uploaded (a bill, receipt or letter) and extracts the amount, payee and due date, ' +
    'suggesting one of your data lakes to file it in. The result is `pending`: nothing is filed or briefed ' +
    'until you confirm it with `PATCH /api/v1/obligations/{id}`. Pass `text` when the device already ' +
    "recognized the page; otherwise the file's indexed text is read. Handing off the same file again returns " +
    'the existing obligation with `200` and is not charged again. An API key without `datalake:write` gets no ' +
    'destination suggestion, and one without a data-lake read scope reads `destination` as `null` on every ' +
    'obligation route.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  emitsRateLimitHeaders: true,
  scopes: SCOPES,
  request: ObligationHandoffRequestSchema,
  requestExample: { file_id: 'file_example' },
  responses: {
    201: { description: 'The extracted obligation, `pending`.', schema: ObligationSchema, example: OBLIGATION_EXAMPLE },
    200: { description: 'This file was already handed off; the existing obligation.', schema: ObligationSchema },
    403: {
      description: `${CONNECTED_APP.description} Also returned (\`spend_frozen\`) when your account or organization spend is frozen.`,
      schema: ApiErrorSchema,
    },
    404: {
      description: "`file_id` names no file of yours. Another user's file reads the same.",
      schema: ApiErrorSchema,
    },
    409: { description: 'The file is still being checked after upload; retry shortly.', schema: ApiErrorSchema },
    422: {
      description:
        'The file cannot be processed, has no readable text, or (`insufficient_credits`) you are out of credits.',
      schema: ApiErrorSchema,
    },
    429: {
      description: `${RATE_LIMITED.description} Also returned when the free tier's daily usage cap is reached.`,
      schema: ApiErrorSchema,
    },
    502: {
      description: 'The assistant could not read the document. Nothing was saved, but the reading is charged.',
      schema: ApiErrorSchema,
    },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { file_id: 'file_example' } },
});

export const listObligationsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/obligations',
  operationId: 'listObligations',
  summary: 'List obligations',
  description:
    'Lists your obligations, newest first, optionally only those in one `status`. Cursor-paginated: pass ' +
    '`next_cursor` back as `cursor` until it is `null`.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  emitsRateLimitHeaders: true,
  scopes: SCOPES,
  queryParams: ListObligationsQuerySchema,
  responses: {
    200: { description: 'One page of obligations.', schema: ListObligationsResponseSchema },
    403: CONNECTED_APP,
    422: { description: 'Invalid query parameter or cursor.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getObligationContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/obligations/{id}',
  operationId: 'getObligation',
  summary: 'Get an obligation',
  description: 'Reads one obligation. Only its owner can read it; anyone else gets `404`, exactly like a missing one.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  emitsRateLimitHeaders: true,
  scopes: SCOPES,
  pathParams: ObligationIdParamSchema,
  responses: {
    200: { description: 'The obligation.', schema: ObligationSchema },
    403: CONNECTED_APP,
    404: NOT_FOUND,
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const updateObligationContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/obligations/{id}',
  operationId: 'updateObligation',
  summary: 'Correct or confirm an obligation',
  description:
    'Corrects the extracted fields and, with `status: "confirmed"`, accepts them: the document is filed into ' +
    'the destination data lake and, when it has a due date, the obligation appears in your briefs ahead of ' +
    'it. A confirmed obligation stays editable; changing its destination files the document into the new ' +
    'lake and leaves it in the old one. `status: "dismissed"` discards it, after which it cannot be changed. ' +
    'Send at least one field.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  emitsRateLimitHeaders: true,
  scopes: SCOPES,
  pathParams: ObligationIdParamSchema,
  request: ObligationUpdateRequestSchema,
  requestExample: { amount: { value: 120.5, currency: 'USD' }, status: 'confirmed' },
  responses: {
    200: { description: 'The updated obligation.', schema: ObligationSchema },
    403: {
      description:
        'The destination is a data lake you can read but not manage or a built-in one, the request sets or ' +
        'files into a destination with an API key lacking `datalake:write`, or the key was minted for a ' +
        'connected app.',
      schema: ApiErrorSchema,
    },
    404: { description: 'No such obligation or destination data lake, or it is not yours.', schema: ApiErrorSchema },
    409: { description: 'The obligation was dismissed and can no longer change.', schema: ApiErrorSchema },
    422: { description: 'The body is invalid or sets no field.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { status: 'confirmed' } },
});
