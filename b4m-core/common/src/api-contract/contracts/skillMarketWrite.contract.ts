import { z } from 'zod';
import { defineEndpoint } from '../defineEndpoint';
import { EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  BrowseSkillListingsQuerySchema,
  BrowseSkillListingsResponseSchema,
  ImportSkillListingRequestSchema,
  ImportSkillListingResponseSchema,
  MySkillListingsQuerySchema,
  MySkillListingsResponseSchema,
  PublishSkillListingRequestSchema,
  RescanSkillVersionResponseSchema,
  SKILL_MARKET_IMPORT_ERROR_CODES,
  SkillListingDetailQuerySchema,
  SkillListingDetailSchema,
  SkillListingIdParamSchema,
  SkillMarketSubmitResponseSchema,
  SkillVersionIdParamSchema,
  SubmitSkillListingVersionRequestSchema,
} from '../../schemas/skillMarketPublic';

/**
 * Skill Market authoring and browsing over an API key. Each route is a `/api/v1` twin of an SPA
 * route under `/api/skills/market/*` and shares its logic (server/skillMarket/author.ts,
 * importListing.ts, search.ts, detail.ts); the SPA routes are unchanged. Reviewing, moderation,
 * ratings and reports are not published here.
 */

// skills:write is accepted for reads so a key that publishes can read back what it wrote.
const READ_SCOPES = [ApiKeyScope.SKILLS_READ, ApiKeyScope.SKILLS_WRITE];
const WRITE_SCOPES = [ApiKeyScope.SKILLS_WRITE];

const READ_FORBIDDEN = 'The API key holds neither `skills:read` nor `skills:write`.';
const WRITE_FORBIDDEN = 'The API key lacks `skills:write`, or the caller may not act on this listing.';
const LISTING_404 =
  'No listing with that id is visible to the caller. A listing you cannot see, a deleted listing and a ' +
  'malformed id are all reported as 404.';
const KEY_429 = 'Per-key rate limit exceeded.';
const SUBMIT_429 = `Submission rate limit exceeded (10 scans per hour and an admin-set daily cap), or ${KEY_429.toLowerCase()}`;
const SCAN_NOTE =
  'Every version is safety-scanned. A clean version goes live at once; one that needs a human waits in ' +
  'review, and importers keep receiving the previous approved version until it is approved.';

const SkillMarketImportConflictSchema = ApiErrorSchema.extend({
  errorCode: z.enum(SKILL_MARKET_IMPORT_ERROR_CODES).optional(),
  suggested_name: z.string().optional().describe('With `name_taken`: a free name to retry with.'),
});

export const listSkillMarketListingsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/listings',
  operationId: 'listSkillMarketListings',
  summary: 'Browse Skill Market listings',
  description:
    'Lists the approved Public listings and the Organization listings of your organizations, with search ' +
    'and filters. Unlisted listings never appear. Cursor-paginated: pass `next_cursor` back as `cursor` ' +
    'until it is `null`, keeping the same filters.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  queryParams: BrowseSkillListingsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of listings.', schema: BrowseSkillListingsResponseSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: {
      description: 'A query value is out of range, or `cursor` is malformed or was issued for a different `limit`.',
      schema: ApiErrorSchema,
    },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const getSkillMarketListingContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/listings/{id}',
  operationId: 'getSkillMarketListing',
  summary: 'Get a Skill Market listing',
  description:
    'Returns a listing with its current approved version, recent ratings and your import of it. The ' +
    'author also sees a listing that is not live. `token` unlocks an unlisted listing. Author-only fields ' +
    '(`share_token`, `source_skill_id`, `pending_version`) need `skills:write` or a signed-in session.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: READ_SCOPES,
  pathParams: SkillListingIdParamSchema,
  queryParams: SkillListingDetailQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The listing.', schema: SkillListingDetailSchema },
    403: { description: READ_FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: LISTING_404, schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const PUBLISH_EXAMPLE = { skill_id: EXAMPLE_RESOURCE_ID, visibility: 'organization', tags: ['review'] };

export const publishSkillMarketListingContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills/market/listings',
  operationId: 'publishSkillMarketListing',
  summary: 'Publish a skill to the Skill Market',
  description:
    `Creates a listing from a skill you own and submits its first version. ${SCAN_NOTE} A skill has at ` +
    'most one live listing: to publish a change, submit a new version instead. Unknown body fields are rejected.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  request: PublishSkillListingRequestSchema,
  requestExample: PUBLISH_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The listing and its scanned first version.', schema: SkillMarketSubmitResponseSchema },
    400: {
      description:
        'The skill was imported from the market, no organization was chosen, a tag is invalid, or you ' +
        'have reached your active listing cap.',
      schema: ApiErrorSchema,
    },
    403: {
      description:
        `${WRITE_FORBIDDEN} Also: you are not in the organization, your account is too new for a Public ` +
        'listing, or moderators removed this skill from the market.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No skill with that id is yours.', schema: ApiErrorSchema },
    409: { description: 'This skill already has a live listing.', schema: ApiErrorSchema },
    429: { description: SUBMIT_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: PUBLISH_EXAMPLE },
});

export const listMySkillMarketListingsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/listings/mine',
  operationId: 'listMySkillMarketListings',
  summary: 'List your Skill Market listings',
  description:
    'Lists the listings you published, newest first, in any status, each with its 5 newest versions and ' +
    'their scan findings and review notes. Cursor-paginated.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  queryParams: MySkillListingsQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of your listings.', schema: MySkillListingsResponseSchema },
    403: { description: 'The API key lacks `skills:write`.', schema: ScopeForbiddenErrorSchema },
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const withdrawSkillMarketListingContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/skills/market/listings/{id}',
  operationId: 'withdrawSkillMarketListing',
  summary: 'Withdraw a Skill Market listing',
  description:
    'Takes your listing off the market. Importers keep their copies; a version awaiting review is ' +
    'superseded. You can publish the skill again afterwards.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillListingIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The listing was withdrawn.', noBody: true },
    403: { description: `${WRITE_FORBIDDEN} Only the author can withdraw.`, schema: ScopeForbiddenErrorSchema },
    404: { description: 'No listing with that id exists.', schema: ApiErrorSchema },
    409: { description: 'The listing is already withdrawn or delisted.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});

export const submitSkillMarketListingVersionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills/market/listings/{id}/versions',
  operationId: 'submitSkillMarketListingVersion',
  summary: 'Submit a new version of a Skill Market listing',
  description:
    `Submits the source skill's current content as the listing's next version. ${SCAN_NOTE} The body is ` + 'optional.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillListingIdParamSchema,
  request: SubmitSkillListingVersionRequestSchema,
  requestExample: {},
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The listing and the scanned version.', schema: SkillMarketSubmitResponseSchema },
    400: {
      description: 'A tag is invalid, or the content is unchanged since the last version.',
      schema: ApiErrorSchema,
    },
    403: {
      description: `${WRITE_FORBIDDEN} Only the author can submit, and only while still in the organization.`,
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'The listing, or the skill it was published from, no longer exists.', schema: ApiErrorSchema },
    409: { description: 'The listing is withdrawn or delisted.', schema: ApiErrorSchema },
    429: { description: SUBMIT_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const importSkillMarketListingContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills/market/listings/{id}/import',
  operationId: 'importSkillMarketListing',
  summary: 'Import a Skill Market listing',
  description:
    "Copies the listing's current approved version into your skills, or with `target_skill_id` refreshes " +
    'an earlier copy. Pending or rejected content is never imported. The body is optional.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillListingIdParamSchema,
  request: ImportSkillListingRequestSchema,
  requestExample: {},
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The earlier copy was updated.', schema: ImportSkillListingResponseSchema },
    201: { description: 'A new copy was created.', schema: ImportSkillListingResponseSchema },
    400: {
      description: 'This is your own listing, the new name is invalid, or the target copy is shared with everyone.',
      schema: ApiErrorSchema,
    },
    403: { description: 'The API key lacks `skills:write`.', schema: ScopeForbiddenErrorSchema },
    404: { description: `${LISTING_404} Also: \`target_skill_id\` is not your copy of it.`, schema: ApiErrorSchema },
    409: {
      description:
        '`version_changed`: a newer version was approved since `expected_version_id`. `local_changes`: you ' +
        'edited the target copy; retry with `overwrite: true`. `name_taken`: retry with `name`. With no ' +
        '`errorCode`: a concurrent write raced the import; retry it.',
      schema: SkillMarketImportConflictSchema,
    },
    429: {
      description: `Import rate limit exceeded (60 per hour), or ${KEY_429.toLowerCase()}`,
      schema: ApiErrorSchema,
    },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const rescanSkillMarketVersionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills/market/versions/{vid}/rescan',
  operationId: 'rescanSkillMarketVersion',
  summary: 'Rescan a Skill Market version',
  description: 'Retries the safety scan of one of your versions whose scan errored or stalled.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: WRITE_SCOPES,
  pathParams: SkillVersionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The rescanned version.', schema: RescanSkillVersionResponseSchema },
    403: { description: `${WRITE_FORBIDDEN} Only the author can rescan.`, schema: ScopeForbiddenErrorSchema },
    404: { description: 'No version with that id exists.', schema: ApiErrorSchema },
    409: {
      description: 'The version is not waiting for a rescan: its scan finished, or another one is running.',
      schema: ApiErrorSchema,
    },
    429: { description: SUBMIT_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
