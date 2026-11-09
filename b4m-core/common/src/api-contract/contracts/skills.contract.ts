import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  CreateSkillRequestSchema,
  MySkillsQuerySchema,
  MySkillsResponseSchema,
  PublicSkillSchema,
  SaveSkillResponseSchema,
  SkillIdParamSchema,
  UpdateSkillRequestSchema,
} from '../../schemas/skillsPublic';

/**
 * Creating, updating and reading your own skills over an API key: the `/api/v1` twin of the Skills
 * page and of POST /api/skills and PUT /api/skills/{id}. Validation is the SPA's (server/utils/skillValidation.ts
 * plus parseSkillMd); the SPA routes are unchanged. Publishing the result is the Skill Market listings route.
 */

// Reads need skills:write too: skills:read is the plaintext Claude Code marketplace key and must not reach private skills.
const WRITE_SCOPES = [ApiKeyScope.SKILLS_WRITE];

const WRITE_FORBIDDEN = 'The API key lacks `skills:write`.';
const SKILL_404 =
  'No skill with that id is visible to the caller. A skill you cannot see, a deleted skill and a malformed id ' +
  'are all reported as 404.';
const KEY_429 = 'Per-key rate limit exceeded.';
const INVALID_SKILL_MD =
  'The SKILL.md or a supporting file is invalid. The message says what to fix: malformed YAML frontmatter, a ' +
  'missing or badly formatted `name` or `description`, a body or file over its size cap, a file outside ' +
  '`scripts/` or `references/`, or a non-text file.';

const CREATE_EXAMPLE = {
  skill_md:
    '---\nname: review-pr\ndescription: Review a pull request for correctness and style.\n---\n\nRead the diff and list the problems you find.\n',
  files: { 'scripts/lint.sh': '#!/bin/sh\nnpm run lint\n' },
};

export const createSkillContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills',
  operationId: 'createSkill',
  summary: 'Create a skill from a SKILL.md',
  description:
    'Creates a skill from the text of a SKILL.md and, optionally, its `scripts/` and `references/` files. It ' +
    'belongs to you unless `scope.organization_id` names an organization you own or manage. The id in the ' +
    'response is what `POST /api/v1/skills/market/listings` takes to publish it. To push a skill from Claude ' +
    "Code: `jq -n --rawfile md ~/.claude/skills/<name>/SKILL.md '{skill_md: $md}' | curl -X POST " +
    '"$B4M_API/api/v1/skills" -H "Authorization: Bearer $B4M_API_KEY" -H "Content-Type: application/json" ' +
    '-d @-`. Unknown body fields are rejected.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  request: CreateSkillRequestSchema,
  requestExample: CREATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The created skill.', schema: SaveSkillResponseSchema },
    400: { description: INVALID_SKILL_MD, schema: ApiErrorSchema },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        '`scope.organization_id` names an organization that does not exist or that you do not own or manage, ' +
        'or is malformed.',
      schema: ApiErrorSchema,
    },
    409: { description: 'You already have a skill with that name.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: CREATE_EXAMPLE },
});

const UPDATE_EXAMPLE = {
  skill_md:
    '---\nname: review-pr\ndescription: Review a pull request for correctness, style and tests.\n---\n\nRead the diff and list the problems you find.\n',
};

export const updateSkillContract = defineEndpoint({
  method: 'put',
  path: '/api/v1/skills/{id}',
  operationId: 'updateSkill',
  summary: 'Update a skill from a SKILL.md',
  description:
    'Replaces the content of a skill with a new SKILL.md. The id, sharing and Skill Market listing are kept. ' +
    'Frontmatter fields the new file omits are cleared. A `name` that differs from the current one needs ' +
    '`allow_rename: true`. Requires the same access as editing the skill in the app. Unknown body fields are rejected.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillIdParamSchema,
  request: UpdateSkillRequestSchema,
  requestExample: UPDATE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The updated skill.', schema: SaveSkillResponseSchema },
    400: {
      description: `${INVALID_SKILL_MD} Also: the change to a skill shared with everyone did not pass the safety scan.`,
      schema: ApiErrorSchema,
    },
    403: {
      description: `${WRITE_FORBIDDEN} Also: you can see the skill but may not edit it.`,
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: SKILL_404, schema: ApiErrorSchema },
    409: {
      description:
        'The SKILL.md renames the skill and `allow_rename` is not `true`, another skill already has the new ' +
        'name, or a concurrent write raced this one. Retry after re-reading the skill.',
      schema: ApiErrorSchema,
    },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: UPDATE_EXAMPLE },
});

export const listMySkillsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/mine',
  operationId: 'listMySkills',
  summary: 'List your skills',
  description:
    'Lists the skills you own, most recently updated first, without their bodies or files; `GET /api/v1/skills/{id}` ' +
    "returns those. With `organization_id`, lists that organization's skills instead. Cursor-paginated: pass " +
    '`next_cursor` back as `cursor` until it is `null`, keeping the same filters.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  queryParams: MySkillsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of skills.', schema: MySkillsResponseSchema },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        '`organization_id` names an organization that does not exist or that you do not own or manage, or is malformed.',
      schema: ApiErrorSchema,
    },
    422: { description: 'A query value is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getSkillContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/{id}',
  operationId: 'getSkill',
  summary: 'Get a skill',
  description:
    'Returns a skill you can access, with its body and supporting files. A skill you do not own that is shared ' +
    'with you, or shared with everyone, is readable too.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The skill.', schema: PublicSkillSchema },
    403: { description: WRITE_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: SKILL_404, schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
