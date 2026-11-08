import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  ArtifactIdParamSchema,
  ArtifactResourceSchema,
  ArtifactVersionParamSchema,
  ArtifactVersionSchema,
  CreateArtifactRequestSchema,
  CreateArtifactVersionRequestSchema,
  ListArtifactsQuerySchema,
  ListArtifactsResponseSchema,
  ListArtifactTypesResponseSchema,
  ListArtifactVersionsResponseSchema,
  SearchArtifactsQuerySchema,
  UpdateArtifactRequestSchema,
} from '../../schemas/artifactPublic';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * Artifacts (diagrams, charts, code, HTML and the like) for integrators: list, create, read, update,
 * delete, and read their version history. New `/api/v1` routes rather than contracts wrapped around
 * the SPA-internal `/api/artifacts/*`, which return the internal document shape; both doors call the
 * same artifactService, so access rules cannot drift apart.
 *
 * Artifacts live in notebooks, so they reuse the notebooks scopes rather than minting new ones.
 * notebooks:write is accepted for reads so a key that writes can read back what it wrote.
 */
const READ_SCOPES = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS];

const READ_FORBIDDEN = 'The API key holds neither `notebooks:read` nor `notebooks:write`.';
const WRITE_FORBIDDEN = 'The API key lacks `notebooks:write`.';
const RATE_LIMITED = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };
const NOT_VISIBLE =
  'No artifact with that id is visible to the caller. An artifact that does not exist, a deleted one and ' +
  'one you cannot read are all reported as 404, so artifact ids cannot be probed through this endpoint.';
const BAD_CURSOR =
  '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A cursor is ' +
  'opaque: pass back exactly the `next_cursor` you were given.';

const ARTIFACT_EXAMPLE = {
  id: '<artifactId>',
  type: 'mermaid',
  title: 'Signup flow',
  description: null,
  version: 2,
  version_tag: null,
  status: 'draft',
  tags: ['onboarding'],
  session_id: '<sessionId>',
  project_id: null,
  visibility: 'private',
  created_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-10-02T09:30:00.000Z',
  content: 'graph TD; A[Sign up] --> B[Verify email]',
};

export const listArtifactsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts',
  operationId: 'listArtifacts',
  summary: 'List artifacts',
  description:
    'Lists the artifacts you own, newest first, excluding deleted ones. Artifacts shared with you are not listed, ' +
    'though `GET /api/v1/artifacts/{id}` resolves them by id. Items carry `content: null`; fetch an ' +
    'artifact by id for its content. Cursor-paginated (see the pagination convention): pass ' +
    '`next_cursor` back as `cursor` until it is `null`.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  queryParams: ListArtifactsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'One page of artifacts, newest first.',
      schema: ListArtifactsResponseSchema,
      example: { data: [{ ...ARTIFACT_EXAMPLE, content: null }], next_cursor: null },
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: { description: BAD_CURSOR, schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const CREATE_EXAMPLE = {
  type: 'mermaid',
  title: 'Signup flow',
  content: 'graph TD; A[Sign up] --> B[Verify email]',
  tags: ['onboarding'],
};

export const createArtifactContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/artifacts',
  operationId: 'createArtifact',
  summary: 'Create an artifact',
  description:
    'Creates a private artifact at version 1. `session_id` files it under a session you can edit, and ' +
    '`project_id` under a project you can read. Unknown body fields are rejected.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  request: CreateArtifactRequestSchema,
  requestExample: CREATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The new artifact.',
      schema: ArtifactResourceSchema,
      example: { ...ARTIFACT_EXAMPLE, version: 1 },
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description: 'The `session_id` or `project_id` does not exist or is not yours to file under.',
      schema: ApiErrorSchema,
    },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: CREATE_EXAMPLE },
});

export const getArtifactContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts/{id}',
  operationId: 'getArtifact',
  summary: 'Get an artifact',
  description: "Returns an artifact you own, one shared with you, or a public one, with its current version's content.",
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ArtifactIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The artifact and its current content.',
      schema: ArtifactResourceSchema,
      example: ARTIFACT_EXAMPLE,
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_VISIBLE, schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const UPDATE_EXAMPLE = { content: 'graph TD; A[Sign up] --> B[Verify email] --> C[Done]' };

export const updateArtifactContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/artifacts/{id}',
  operationId: 'updateArtifact',
  summary: 'Update an artifact',
  description:
    'Updates an artifact you can edit: one you own, or one shared with you with write permission. ' +
    'Changed `content` creates a new version; the other fields change in place. Omitted fields are left ' +
    'unchanged. Unknown body fields are rejected.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: ArtifactIdParamSchema,
  request: UpdateArtifactRequestSchema,
  requestExample: UPDATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description:
        'The updated artifact and its current content. `content` is `null` for a caller who may edit but ' +
        'not read the artifact, unless the request sent content.',
      schema: ArtifactResourceSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No artifact with that id is yours to edit. One you can only read (shared read-only, or public) ' +
        'is reported as 404 too, like one that does not exist.',
      schema: ApiErrorSchema,
    },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: UPDATE_EXAMPLE },
});

export const deleteArtifactContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/artifacts/{id}',
  operationId: 'deleteArtifact',
  summary: 'Delete an artifact',
  description: 'Deletes an artifact you own, or one shared with you with delete permission.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: ArtifactIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The artifact was deleted.', noBody: true },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No artifact with that id is yours to delete. One you cannot delete is reported as 404 too, like ' +
        'one that does not exist.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});

export const listArtifactVersionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts/{id}/versions',
  operationId: 'listArtifactVersions',
  summary: 'List artifact versions',
  description:
    "Lists an artifact's versions, oldest first. Items carry `content: null`; fetch a version for its " +
    'content. Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until ' +
    'it is `null`.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ArtifactIdParamSchema,
  queryParams: ListArtifactsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'One page of versions, in version order.',
      schema: ListArtifactVersionsResponseSchema,
      example: {
        data: [
          {
            version: 1,
            version_tag: null,
            change_description: 'Created artifact',
            created_at: '2026-10-01T12:00:00.000Z',
            content: null,
          },
        ],
        next_cursor: null,
      },
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_VISIBLE, schema: ApiErrorSchema },
    422: { description: BAD_CURSOR, schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getArtifactVersionContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts/{id}/versions/{version}',
  operationId: 'getArtifactVersion',
  summary: 'Get an artifact version',
  description: 'Returns one version of an artifact you can read, with its content.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ArtifactVersionParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The version and its content.',
      schema: ArtifactVersionSchema,
      example: {
        version: 1,
        version_tag: null,
        change_description: 'Created artifact',
        created_at: '2026-10-01T12:00:00.000Z',
        content: 'graph TD; A[Sign up] --> B[Verify email]',
      },
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description: `${NOT_VISIBLE} A version that does not exist, or one that is not a positive integer, is also 404.`,
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const CREATE_VERSION_EXAMPLE = {
  content: 'graph TD; A[Sign up] --> B[Verify email] --> C[Done]',
  change_description: 'Added the final step',
  version_tag: 'v2',
};

export const createArtifactVersionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/artifacts/{id}/versions',
  operationId: 'createArtifactVersion',
  summary: 'Create an artifact version',
  description:
    'Adds a new version to an artifact you can edit, even when `content` is unchanged, and makes it the ' +
    'current one. `PATCH /api/v1/artifacts/{id}` also versions changed content, but it cannot tag a version ' +
    'or force one for unchanged content. ' +
    'Unknown body fields are rejected.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_NOTEBOOKS],
  pathParams: ArtifactIdParamSchema,
  request: CreateArtifactVersionRequestSchema,
  requestExample: CREATE_VERSION_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The artifact at its new version, with the content that was sent.',
      schema: ArtifactResourceSchema,
      example: { ...ARTIFACT_EXAMPLE, version: 3, version_tag: 'v2', content: CREATE_VERSION_EXAMPLE.content },
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No artifact with that id is yours to edit. One you can only read (shared read-only, or public) ' +
        'is reported as 404 too, like one that does not exist.',
      schema: ApiErrorSchema,
    },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: CREATE_VERSION_EXAMPLE },
});

export const searchArtifactsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts/search',
  operationId: 'searchArtifacts',
  summary: 'Search artifacts',
  description:
    'Full-text search over the artifacts you own, excluding deleted ones, newest first. Items carry ' +
    '`content: null`; fetch an artifact by id for its content. Cursor-paginated (see the pagination ' +
    'convention): pass `next_cursor` back as `cursor` until it is `null`, and start again without a cursor ' +
    'when `q` or `type` changes.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  queryParams: SearchArtifactsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'One page of matching artifacts, newest first.',
      schema: ListArtifactsResponseSchema,
      example: { data: [{ ...ARTIFACT_EXAMPLE, content: null }], next_cursor: null },
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: {
      description:
        '`q` is missing or too long, `limit` or `type` is invalid, or `cursor` is malformed or was issued by a different endpoint.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listArtifactTypesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/artifacts/types',
  operationId: 'listArtifactTypes',
  summary: 'List artifact types',
  description:
    "The fixed catalog of artifact types a `type` field accepts, with each one's name, description, " +
    'category and MIME type. It is a small bounded set, returned whole rather than paginated.',
  tags: ['Artifacts'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'Every artifact type and the categories they fall into.',
      schema: ListArtifactTypesResponseSchema,
      example: {
        types: [
          {
            type: 'mermaid',
            name: 'Mermaid Diagram',
            description: 'Flowcharts, sequence diagrams, and other visual diagrams using Mermaid syntax',
            category: 'visualization',
            mime_type: 'text/plain',
          },
        ],
        categories: ['visualization'],
      },
    },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
