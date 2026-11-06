import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_FILE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ProjectIdParamSchema } from '../../schemas/projectPublic';
import {
  AddProjectSystemPromptsRequestSchema,
  CreateProjectInviteRequestSchema,
  CreatedProjectInviteSchema,
  ListProjectInvitesResponseSchema,
  ProjectInviteStatusQuerySchema,
  ProjectMemberParamSchema,
  ProjectSystemPromptParamSchema,
  ProjectSystemPromptsResponseSchema,
  UpdateProjectSystemPromptRequestSchema,
} from '../../schemas/projectSharingPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * Who a project is shared with and the system prompts its chats use, as `/api/v1` twins of the SPA
 * routes `/api/projects/{id}/members`, `/invites` and `/systemPrompts` (which are unchanged). The
 * project itself is projects.contract.ts; its files and sessions are projectContent.contract.ts.
 */

// Same pairing as the SPA invites route: projects:write is accepted for the read so a key that
// invites people can list what it sent without also being minted projects:read.
const READ_SCOPES = [ApiKeyScope.READ_PROJECTS, ApiKeyScope.WRITE_PROJECTS];

const READ_FORBIDDEN = 'The API key holds neither `projects:read` nor `projects:write`.';
const WRITE_FORBIDDEN = 'The API key lacks `projects:write`.';

const NOT_SHAREABLE_404 =
  'No project with that id is yours to share. A project you can read but not share, one that does ' +
  'not exist, a deleted project and a malformed id are all reported as 404, so project ids cannot be ' +
  'probed through this endpoint.';

const NOT_UPDATABLE_404 =
  'No project with that id is yours to change. A project you can only read, one that does not exist, ' +
  'a deleted project and a malformed id are all reported as 404, so project ids cannot be probed ' +
  'through this endpoint.';

const SYSTEM_PROMPTS_NOTE =
  "A project's system prompts are files whose text is added to every chat in the project, in order, " +
  'while enabled.';

const RATE_LIMITED = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };

const ADD_PROMPTS_EXAMPLE = { file_ids: [EXAMPLE_FILE_ID] };
const UPDATE_PROMPT_EXAMPLE = { enabled: false };
const INVITE_EXAMPLE = {
  permissions: ['read'],
  recipients: ['teammate@example.com'],
  description: 'Here is the research project.',
};

export const removeProjectMemberContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/projects/{id}/members/{user_id}',
  operationId: 'removeProjectMember',
  summary: 'Remove a member from a project, or leave it',
  description:
    "Ends a user's access to a project. The project owner can remove any member. Anyone else can " +
    'remove only themselves, which leaves the project: pass your own user id (`GET /api/v1/me`). The ' +
    'owner cannot leave their own project. The files and sessions the member grouped in the project ' +
    'are ungrouped, and the access the project granted the member on the rest is revoked.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectMemberParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The user is no longer a member of the project.', noBody: true },
    403: {
      description:
        'The API key lacks `projects:write`, the caller is not the owner and named someone else, or the ' +
        'owner named themselves.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: {
      description:
        'No project with that id is visible to the caller, or the owner named a user who is not a ' +
        'member. A malformed id is reported as 404 too, so ids cannot be probed through this endpoint.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});

export const listProjectInvitesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/projects/{id}/invites',
  operationId: 'listProjectInvites',
  summary: "List a project's invites",
  description:
    'Lists the invites sent for a project you can share. Recipient addresses you did not type ' +
    'yourself are withheld (see `recipients`). Share links are never returned here. ' +
    'Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until it ' +
    'is `null`.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: ProjectIdParamSchema,
  queryParams: PaginationQuerySchema.extend({
    status: ProjectInviteStatusQuerySchema.optional().describe(
      'Only invites with at least one recipient in this state.'
    ),
  }),
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of invites, ordered by `id`.', schema: ListProjectInvitesResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_SHAREABLE_404, schema: ApiErrorSchema },
    422: {
      description:
        '`limit` or `status` is out of range, or `cursor` is malformed or was issued by a different ' +
        'endpoint. A cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const createProjectInviteContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/projects/{id}/invites',
  operationId: 'createProjectInvite',
  summary: 'Invite people to a project',
  description:
    'Creates an invite to a project you can share and emails each recipient a link. With no ' +
    'recipients it creates a share link that names nobody. The response carries the link once. ' +
    'Recipient email is sent in the background, so a mail failure does not fail the invite. Unknown ' +
    'body fields are rejected.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectIdParamSchema,
  request: CreateProjectInviteRequestSchema,
  requestExample: INVITE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The invite, with its share link.', schema: CreatedProjectInviteSchema },
    400: {
      description: 'The body is not valid JSON, or the invite cannot be created as asked.',
      schema: ApiErrorSchema,
    },
    403: {
      description: "The API key lacks `projects:write`, or the caller's account may not send invitations right now.",
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: NOT_SHAREABLE_404, schema: ApiErrorSchema },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: {
      description: 'Per-user rate limit exceeded, or the invitation email budget is used up.',
      schema: ApiErrorSchema,
    },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: INVITE_EXAMPLE },
});

export const addProjectSystemPromptsContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/projects/{id}/system-prompts',
  operationId: 'addProjectSystemPrompts',
  summary: 'Add system prompts to a project',
  description:
    `${SYSTEM_PROMPTS_NOTE} Adds files as enabled system prompts, after the existing ones, in a ` +
    'project you own or can edit. Every listed file must be readable by the caller, and anyone the ' +
    'project is shared with can then read it. Files that are already system prompts are left as they ' +
    'are. Unknown body fields are rejected.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectIdParamSchema,
  request: AddProjectSystemPromptsRequestSchema,
  requestExample: ADD_PROMPTS_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: "The project's system prompts.", schema: ProjectSystemPromptsResponseSchema },
    400: {
      description:
        'A listed file does not exist or is not readable by the caller, every listed file is already a ' +
        'system prompt, or the body is not valid JSON. Nothing is added.',
      schema: ApiErrorSchema,
    },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_UPDATABLE_404, schema: ApiErrorSchema },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: ADD_PROMPTS_EXAMPLE },
});

export const updateProjectSystemPromptContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/projects/{id}/system-prompts/{file_id}',
  operationId: 'updateProjectSystemPrompt',
  summary: 'Enable or disable a project system prompt',
  description:
    `${SYSTEM_PROMPTS_NOTE} Sets whether one of them is used, in a project you own or can edit. ` +
    'Setting the state it already has changes nothing. Unknown body fields are rejected.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectSystemPromptParamSchema,
  request: UpdateProjectSystemPromptRequestSchema,
  requestExample: UPDATE_PROMPT_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: "The project's system prompts.", schema: ProjectSystemPromptsResponseSchema },
    400: { description: 'The body is not valid JSON.', schema: ApiErrorSchema },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description: `${NOT_UPDATABLE_404} A file that is not one of the project's system prompts is a 404 too.`,
      schema: ApiErrorSchema,
    },
    422: { description: 'Request body failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: UPDATE_PROMPT_EXAMPLE },
});

export const removeProjectSystemPromptContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/projects/{id}/system-prompts/{file_id}',
  operationId: 'removeProjectSystemPrompt',
  summary: 'Remove a system prompt from a project',
  description:
    `${SYSTEM_PROMPTS_NOTE} Removes one of them from a project you own or can edit. The file itself, ` +
    'and any access the project granted on it, are kept. Removing a file that is not a system prompt ' +
    'changes nothing and answers 204.',
  tags: ['Projects'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_PROJECTS],
  pathParams: ProjectSystemPromptParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The file is not a system prompt of the project.', noBody: true },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_UPDATABLE_404, schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
