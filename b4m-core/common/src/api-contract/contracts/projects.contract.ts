import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_FILE_ID, EXAMPLE_SESSION_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  CreateProjectRequestSchema,
  ListProjectsResponseSchema,
  ProjectIdParamSchema,
  ProjectResourceSchema,
} from '../../schemas/projectPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * The integrator-facing subset of the project API. Each route is a `/api/v1` twin of an SPA route
 * under `/api/projects/*` and reuses its service logic; the SPA routes are unchanged. Update, delete
 * and every sub-resource (files, sessions, members, invites, system prompts) are deliberately not
 * published yet.
 */

// projects:write is accepted for reads so a key that creates projects can read back what it wrote
// without also being minted projects:read.
const READ_SCOPES = [ApiKeyScope.READ_PROJECTS, ApiKeyScope.WRITE_PROJECTS];

const READ_FORBIDDEN = 'The API key holds neither `projects:read` nor `projects:write`.';

const MEMBERSHIP_NOTE =
  "A project's `file_ids` and `session_ids` are shared with it: anyone the project is shared with can " +
  'read every file and session it groups.';

export const listProjectsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/projects',
  operationId: 'listProjects',
  summary: 'List projects',
  description:
    'Lists the projects the caller can read: projects they own and projects shared with them. ' +
    `${MEMBERSHIP_NOTE} Cursor-paginated (see the pagination convention): pass \`next_cursor\` back ` +
    'as `cursor` until it is `null`.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of projects, ordered by `id`.', schema: ListProjectsResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
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

export const getProjectContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/projects/{id}',
  operationId: 'getProject',
  summary: 'Get a project',
  description: `Returns one project the caller can read. ${MEMBERSHIP_NOTE}`,
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ProjectIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The project.', schema: ProjectResourceSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No project with that id is visible to the caller. A project that exists but is not yours to ' +
        'read, a deleted project and a malformed id are all reported as 404, so project ids cannot be ' +
        'probed through this endpoint.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const CREATE_EXAMPLE = {
  name: 'Market research',
  description: 'Sources and notes for the Q3 market analysis.',
  session_ids: [EXAMPLE_SESSION_ID],
  file_ids: [EXAMPLE_FILE_ID],
};

export const createProjectContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/projects',
  operationId: 'createProject',
  summary: 'Create a project',
  description:
    'Creates a project owned by the caller, optionally grouping existing sessions and files in it. ' +
    'Every listed session and file must be readable by the caller. ' +
    `${MEMBERSHIP_NOTE} Sharing the project later shares them too. Unknown body fields are rejected.`,
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  request: CreateProjectRequestSchema,
  requestExample: CREATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The created project.', schema: ProjectResourceSchema },
    400: {
      description:
        'A listed session or file does not exist or is not readable by the caller, or the body is not ' +
        'valid JSON. Nothing is created.',
      schema: ApiErrorSchema,
    },
    403: { description: 'The API key lacks `projects:write`.', schema: ScopeForbiddenErrorSchema },
    422: {
      description: 'Request body failed validation, or you already have a live project with this `name`.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: CREATE_EXAMPLE },
});
