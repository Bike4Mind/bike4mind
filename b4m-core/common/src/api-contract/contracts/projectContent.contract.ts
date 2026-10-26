import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_FILE_ID, EXAMPLE_SESSION_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ProjectIdParamSchema, ProjectResourceSchema } from '../../schemas/projectPublic';
import {
  AddProjectFilesRequestSchema,
  AddProjectSessionsRequestSchema,
  ListProjectFilesResponseSchema,
  ListProjectSessionsResponseSchema,
  ProjectFileParamSchema,
  ProjectSessionParamSchema,
} from '../../schemas/projectContentPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * The files and sessions a project groups, as `/api/v1` twins of the SPA routes
 * `/api/projects/{id}/files` and `/api/projects/{id}/sessions` (which are unchanged). The project
 * itself is projects.contract.ts; its `file_ids` and `session_ids` list the same members.
 */

// projects:write is accepted for reads so a key that attaches content can read back what it wrote
// without also being minted projects:read.
const READ_SCOPES = [ApiKeyScope.READ_PROJECTS, ApiKeyScope.WRITE_PROJECTS];

const READ_FORBIDDEN = 'The API key holds neither `projects:read` nor `projects:write`.';
const WRITE_FORBIDDEN = 'The API key lacks `projects:write`.';

const MEMBERSHIP_NOTE =
  'Anyone the project is shared with can read every file and session it groups, so grouping content ' +
  'shares it with them, and ungrouping it revokes the access the project granted.';

const NOT_VISIBLE_404 =
  'No project with that id is visible to the caller. A project that exists but is not yours to read, ' +
  'a deleted project and a malformed id are all reported as 404, so project ids cannot be probed ' +
  'through this endpoint.';

const NOT_UPDATABLE_404 =
  'No project with that id is yours to change. A project you can only read, one that does not exist, ' +
  'a deleted project and a malformed id are all reported as 404, so project ids cannot be probed ' +
  'through this endpoint.';

const CURSOR_422 =
  '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A cursor ' +
  'is opaque: pass back exactly the `next_cursor` you were given.';

const FILES_EXAMPLE = { file_ids: [EXAMPLE_FILE_ID] };
const SESSIONS_EXAMPLE = { session_ids: [EXAMPLE_SESSION_ID] };

export const listProjectFilesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/projects/{id}/files',
  operationId: 'listProjectFiles',
  summary: "List a project's files",
  description:
    'Lists the files grouped in a project the caller can read, as file summaries (no download URL: read ' +
    'one file by id for that). Files that have since been deleted are omitted. ' +
    `${MEMBERSHIP_NOTE} Cursor-paginated (see the pagination convention): pass \`next_cursor\` back as ` +
    '`cursor` until it is `null`.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ProjectIdParamSchema,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of file summaries, ordered by `id`.', schema: ListProjectFilesResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_VISIBLE_404, schema: ApiErrorSchema },
    422: { description: CURSOR_422, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const addProjectFilesContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/projects/{id}/files',
  operationId: 'addProjectFiles',
  summary: 'Add files to a project',
  description:
    'Groups existing files in a project you own or can edit. Every listed file must be readable by the ' +
    'caller. Files already in the project are left as they are. ' +
    `${MEMBERSHIP_NOTE} Unknown body fields are rejected. Nothing is attached if any file is rejected.`,
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectIdParamSchema,
  request: AddProjectFilesRequestSchema,
  requestExample: FILES_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The project with the files added.', schema: ProjectResourceSchema },
    400: {
      description:
        'A listed file does not exist or is not readable by the caller, or the body is not valid JSON. ' +
        'Nothing is attached.',
      schema: ApiErrorSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_UPDATABLE_404, schema: ApiErrorSchema },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: FILES_EXAMPLE },
});

export const removeProjectFileContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/projects/{id}/files/{file_id}',
  operationId: 'removeProjectFile',
  summary: 'Remove a file from a project',
  description:
    'Ungroups a file from a project. The file itself is kept, but the access the project granted on it ' +
    'is revoked. The project owner can remove any file; anyone else with access to the project can ' +
    'remove only files they own. The owner can also remove a `file_ids` entry whose file was since ' +
    'deleted. Removing a file that is not in the project is a no-op that still answers 204.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectFileParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The file is no longer in the project.', noBody: true },
    403: {
      description:
        'The API key lacks `projects:write`, or the caller does not own the project and does not own the file.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: {
      description:
        'No project with that id is visible to the caller, or no file with that id is readable by the ' +
        'caller. A malformed id is reported as 404 too, so ids cannot be probed through this endpoint.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});

export const listProjectSessionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/projects/{id}/sessions',
  operationId: 'listProjectSessions',
  summary: "List a project's sessions",
  description:
    'Lists the sessions (called "notebooks" in the product UI) grouped in a project the caller can read. ' +
    'Each item has the same shape `GET /api/v1/sessions` returns. Sessions that have since been deleted ' +
    `are omitted. ${MEMBERSHIP_NOTE} Cursor-paginated (see the pagination convention): pass ` +
    '`next_cursor` back as `cursor` until it is `null`.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ProjectIdParamSchema,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of sessions, ordered by `id`.', schema: ListProjectSessionsResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_VISIBLE_404, schema: ApiErrorSchema },
    422: { description: CURSOR_422, schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const addProjectSessionsContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/projects/{id}/sessions',
  operationId: 'addProjectSessions',
  summary: 'Add sessions to a project',
  description:
    'Groups existing sessions in a project you own or can edit. Every listed session must be readable by ' +
    'the caller. The knowledge files a session uses are grouped with it. Attaching a session queues a ' +
    "summary of it, billed to the caller's credits; when the credits are insufficient the summary is " +
    'skipped and the attach still succeeds. ' +
    `${MEMBERSHIP_NOTE} Unknown body fields are rejected. Nothing is attached if any session is rejected.`,
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectIdParamSchema,
  request: AddProjectSessionsRequestSchema,
  requestExample: SESSIONS_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The project with the sessions added.', schema: ProjectResourceSchema },
    400: {
      description:
        'A listed session does not exist or is not readable by the caller, or the body is not valid ' +
        'JSON. Nothing is attached.',
      schema: ApiErrorSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_UPDATABLE_404, schema: ApiErrorSchema },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: SESSIONS_EXAMPLE },
});

export const removeProjectSessionContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/projects/{id}/sessions/{session_id}',
  operationId: 'removeProjectSession',
  summary: 'Remove a session from a project',
  description:
    'Ungroups a session from a project. The session itself is kept, but the access the project granted ' +
    'on it is revoked. The project owner can remove any session; anyone else with access to the project ' +
    'can remove only sessions they own. The owner can also remove a `session_ids` entry whose session ' +
    'was since deleted. Removing a session that is not in the project is a no-op that still answers 204.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectSessionParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The session is no longer in the project.', noBody: true },
    403: {
      description:
        'The API key lacks `projects:write`, or the caller does not own the project and does not own the ' + 'session.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: {
      description:
        'No project with that id is visible to the caller, or no session with that id is readable by the ' +
        'caller. A malformed id is reported as 404 too, so ids cannot be probed through this endpoint.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
