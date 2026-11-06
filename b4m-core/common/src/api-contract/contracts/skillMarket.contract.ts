import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  ClaudeMarketplaceQuerySchema,
  ClaudeMarketplaceSchema,
  ClaudePluginZipParamSchema,
  ClaudePluginZipQuerySchema,
} from '../../schemas/claudeMarketplace';

const AUTH_NOTE =
  'Authenticate with an API key (`b4m_live_`) carrying `skills:read`, sent as `Authorization: Bearer`. ' +
  "Claude Code sends that header when it is set as the marketplace source's `headers` in its settings, " +
  'and forwards it to the same-origin plugin archives.';

/**
 * The Skill Market as a Claude Code plugin marketplace: one feed per org, one archive plugin per
 * approved Organization listing, plus one per skill bundle. Both routes serve only what the caller can already browse.
 */
export const getClaudeMarketplaceContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/claude-marketplace.json',
  operationId: 'getClaudeMarketplace',
  summary: "Get an organization's Claude Code plugin marketplace",
  description:
    "Returns a Claude Code `marketplace.json` listing the organization's approved Organization-visibility " +
    'Skill Market listings, one `archive` plugin each, pinned by `sha256`, followed by one `archive` plugin ' +
    'per skill bundle whose `version` is a hash prefix, not a semantic version. Public and unlisted listings are ' +
    `not included. Responses are never cacheable. ${AUTH_NOTE}`,
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.SKILLS_READ],
  queryParams: ClaudeMarketplaceQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The marketplace.',
      schema: ClaudeMarketplaceSchema,
      example: {
        name: `b4m-org-${EXAMPLE_RESOURCE_ID}`,
        owner: { name: 'Acme' },
        forceRemoveDeletedPlugins: true,
        plugins: [
          {
            name: 'review-pr',
            description: 'Review a pull request against the team checklist.',
            version: '3',
            source: {
              source: 'archive',
              url: `https://app.bike4mind.com/api/v1/skills/market/${EXAMPLE_RESOURCE_ID}/claude-plugin.zip?version=3`,
              sha256: 'a3f1c0de9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060f5e',
            },
          },
        ],
      },
    },
    403: {
      description: 'The API key lacks `skills:read`, or the caller is not a member of the organization.',
      schema: ScopeForbiddenErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getClaudePluginZipContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/{id}/claude-plugin.zip',
  operationId: 'getClaudePluginZip',
  summary: 'Download a Skill Market listing as a Claude Code plugin',
  description:
    'A zip holding an approved version as `skills/<name>/SKILL.md`, plus any supporting files the ' +
    'version ships under `skills/<name>/scripts/` and `skills/<name>/references/`. The optional `version` query pins ' +
    'the listing version advertised by the feed, so later approvals do not change its bytes or `sha256`. ' +
    `Without it, returns the current approved version. ${AUTH_NOTE}`,
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.SKILLS_READ],
  pathParams: ClaudePluginZipParamSchema,
  queryParams: ClaudePluginZipQuerySchema,
  validationErrorStatus: 400,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The plugin archive.', contentType: 'application/zip' },
    400: { description: 'Invalid version query.', schema: ApiErrorSchema },
    403: { description: 'The API key lacks `skills:read`.', schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No Organization listing with that id is visible to the caller. A listing in an org you are not ' +
        'in, a public or unlisted listing, and a malformed id are all reported as 404.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getClaudeBundleZipContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/bundles/{id}/claude-plugin.zip',
  operationId: 'getClaudeBundleZip',
  summary: 'Download a Skill Market bundle as a Claude Code plugin',
  description:
    "A zip holding the current approved version of each of an organization bundle's member listings, " +
    'each as `skills/<plugin name>/SKILL.md` plus its supporting files. Members that are no longer ' +
    `approved or visible are left out. ${AUTH_NOTE}`,
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.SKILLS_READ],
  pathParams: ClaudePluginZipParamSchema,
  validationErrorStatus: 400,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The plugin archive.', contentType: 'application/zip' },
    403: { description: 'The API key lacks `skills:read`.', schema: ScopeForbiddenErrorSchema },
    404: {
      description:
        'No bundle with that id is visible to the caller, or none of its members is approved. A bundle in an ' +
        'org you are not in and a malformed id are both reported as 404.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
