import { defineEndpoint } from '../defineEndpoint';
import {
  DATA_LAKE_QUERY_API_KEY_SCOPES,
  DATA_LAKE_READ_API_KEY_SCOPES,
  DATA_LAKE_WRITE_API_KEY_SCOPES,
} from '../../constants/dataLakeApiKeyScopes';
import {
  DataLakeFileMembershipResponseSchema,
  DataLakeFileParamSchema,
  DataLakeFileResponseSchema,
  DataLakeIdParamSchema,
  DataLakeResourceSchema,
  DataLakeSearchRequestSchema,
  DataLakeSearchResponseSchema,
  ListDataLakesResponseSchema,
  ProviderNotConfiguredErrorSchema,
} from '../../schemas/dataLakePublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, InsufficientCreditsErrorSchema } from '../../schemas/chat';

/**
 * The integrator-facing subset of the data-lake API. Each route is a `/api/v1` twin of an SPA route
 * under `/api/data-lakes/*` and reuses its service logic; the SPA routes are unchanged. Every route
 * is also gated on the `EnableDataLakes` admin setting, which answers 403 when the feature is off.
 */

const FEATURE_DISABLED_NOTE = 'or Data Lakes are disabled on this deployment';

const NOT_VISIBLE_LAKE =
  'No lake with that id or slug is visible to the caller. A lake that exists but is not yours to read ' +
  'is reported as 404 too, so lake ids cannot be probed through this endpoint.';

const WRITE_FORBIDDEN =
  'The API key lacks `datalake:write`, the caller can read this lake but may not change its membership ' +
  `(including every built-in lake, which is read-only), ${FEATURE_DISABLED_NOTE}.`;

export const listDataLakesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/data-lakes',
  operationId: 'listDataLakes',
  summary: 'List data lakes',
  description:
    'Lists the data lakes the caller can reach as a member: lakes they own, lakes shared with them ' +
    'through an organization or an access grant, public lakes, and the built-in lakes their plan ' +
    'entitles them to. Platform-administrator reach is deliberately NOT applied here, so an admin key ' +
    "lists its owner's own lakes rather than every lake on the platform. Only `draft` and `active` " +
    'lakes are listed. Cursor-paginated (see the pagination convention): pass `next_cursor` back as ' +
    '`cursor` until it is `null`.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_READ_API_KEY_SCOPES,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of lakes, ordered by `id`.', schema: ListDataLakesResponseSchema },
    403: {
      description: `The API key holds none of \`datalake:read\`, \`datalake:write\` or \`datalake:query\`, ${FEATURE_DISABLED_NOTE}.`,
      schema: ApiErrorSchema,
    },
    422: {
      description:
        '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A ' +
        'cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getDataLakeContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/data-lakes/{id}',
  operationId: 'getDataLake',
  summary: 'Get a data lake',
  description:
    'Returns one data lake by id or slug. Every caller - owner and editor included - receives the ' +
    'same reader projection; management settings are not part of the public shape. `file_count` and ' +
    '`total_size_bytes` for a built-in lake are computed live.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_READ_API_KEY_SCOPES,
  pathParams: DataLakeIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The lake.', schema: DataLakeResourceSchema },
    403: {
      description: `The API key holds none of \`datalake:read\`, \`datalake:write\` or \`datalake:query\`, ${FEATURE_DISABLED_NOTE}.`,
      schema: ApiErrorSchema,
    },
    404: { description: NOT_VISIBLE_LAKE, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const FILE_NOT_FOUND =
  'The lake is not visible to the caller, or the file does not exist, was deleted, or is not a current ' +
  'member of this lake. All of these are one 404, so neither lake nor file ids can be probed.';

export const getDataLakeFileContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/data-lakes/{id}/files/{file_id}',
  operationId: 'getDataLakeFile',
  summary: 'Get a data lake file',
  description:
    "Returns a lake member's ingestion status. Adding a file to a lake does NOT ingest it: a file only " +
    'becomes searchable once it has been chunked and embedded, so poll this endpoint until ' +
    '`ingestion_status` is `ready`. `indexing` clears on its own; `paused` means re-processing was ' +
    'stopped partway and needs the file reprocessed (or background lake work resumed) before it ' +
    'returns; `failed` carries the reason in `error`; `not_ingested` means no ingestion has started. ' +
    'These agree with what search reports under `retrieval_unavailable`.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_READ_API_KEY_SCOPES,
  pathParams: DataLakeFileParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The member file and its ingestion state.', schema: DataLakeFileResponseSchema },
    403: {
      description: `The API key holds none of \`datalake:read\`, \`datalake:write\` or \`datalake:query\`, ${FEATURE_DISABLED_NOTE}.`,
      schema: ApiErrorSchema,
    },
    404: { description: FILE_NOT_FOUND, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const addDataLakeFileContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/data-lakes/{id}/files/{file_id}',
  operationId: 'addDataLakeFile',
  summary: 'Add a file to a data lake',
  description:
    'Makes an existing file a member of the lake. Takes no body. Idempotent: adding a file that is ' +
    'already a member succeeds and changes nothing. Outside the restore window below, a caller can add ' +
    "only their own files (or, as the lake's owner, the owner's files); any other file is a 404. " +
    'Membership alone does not ingest the file - poll `GET /api/v1/data-lakes/{id}/files/{file_id}` ' +
    'until it is `ready` before relying on it in search. Re-adding a file within about 30 minutes of ' +
    'removing it restores the membership it had.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_WRITE_API_KEY_SCOPES,
  pathParams: DataLakeFileParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: "The file is a member; the lake's updated totals.",
      schema: DataLakeFileMembershipResponseSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ApiErrorSchema },
    404: {
      description:
        'The lake is not visible to the caller, or the file does not exist, was deleted, or is not one the ' +
        'caller may add. Reported as one 404 so file ids cannot be probed.',
      schema: ApiErrorSchema,
    },
    400: {
      description:
        "The file does not meet the lake's admission policy (for example, its passages were chunked to a " +
        'size the lake does not accept). Reprocess the file to the required size, then add it again.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const removeDataLakeFileContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/data-lakes/{id}/files/{file_id}',
  operationId: 'removeDataLakeFile',
  summary: 'Remove a file from a data lake',
  description:
    'Drops the file from the lake. Only membership changes: the file itself and its indexed passages ' +
    "are untouched, and the file's owner still finds it in their own library. Re-adding it within about " +
    '30 minutes (`POST` on the same path) restores the membership it had.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_WRITE_API_KEY_SCOPES,
  pathParams: DataLakeFileParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: "The file is no longer a member; the lake's updated totals.",
      schema: DataLakeFileMembershipResponseSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ApiErrorSchema },
    404: {
      description: 'The lake is not visible to the caller, or the file is not a current member of it.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const searchDataLakeContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/data-lakes/{id}/search',
  operationId: 'searchDataLake',
  summary: 'Search a data lake',
  description:
    'Semantic (vector) search over one lake: the query is embedded with the model the corpus was ' +
    'indexed with and the top `top_k` passages at or above `min_score` are returned. Only members of ' +
    "this lake are searched - never the caller's other files. `tags` narrows to files carrying any " +
    'of the listed tags. Files still being indexed or paused are withheld rather than searched stale: ' +
    '`partial_results` is then true and `retrieval_unavailable` counts them (poll ' +
    '`GET /api/v1/data-lakes/{id}/files/{file_id}` for a specific file). The query embedding is ' +
    'billed as credits. Limited to 10 searches per minute per caller, shared with the product UI.',
  tags: ['Data Lakes'],
  auth: 'apiKeyOrJwt',
  scopes: DATA_LAKE_QUERY_API_KEY_SCOPES,
  pathParams: DataLakeIdParamSchema,
  request: DataLakeSearchRequestSchema,
  requestExample: { query: 'What is our refund policy for annual plans?', top_k: 5 },
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The ranked passages and what, if anything, was withheld.',
      schema: DataLakeSearchResponseSchema,
    },
    403: {
      description: `The API key lacks \`datalake:query\`, ${FEATURE_DISABLED_NOTE}.`,
      schema: ApiErrorSchema,
    },
    404: {
      description:
        `${NOT_VISIBLE_LAKE} A lake the caller can read but is not entitled to search is reported the same way, ` +
        'as is a lake that is not `active` yet (a draft lake is readable but not yet searchable).',
      schema: ApiErrorSchema,
    },
    422: {
      description:
        'Request body failed validation, or the caller cannot afford the query embedding - the latter is ' +
        'tagged `errorCode: "insufficient_credits"` (the balance is short, or the org member credit cap is exhausted).',
      schema: InsufficientCreditsErrorSchema,
    },
    429: {
      description: 'Search rate limit (10 per minute) or per-user API rate limit exceeded.',
      schema: ApiErrorSchema,
    },
    503: {
      description:
        'No usable key is configured on this deployment for the embedding provider the query needs ' +
        '(`errorCode: "provider_not_configured"`).',
      schema: ProviderNotConfiguredErrorSchema,
    },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { query: 'What is our refund policy for annual plans?', top_k: 5 },
  },
});
