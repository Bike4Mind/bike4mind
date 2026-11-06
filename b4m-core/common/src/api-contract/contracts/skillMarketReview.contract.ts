import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
  ReviewSkillVersionRequestSchema,
  ReviewSkillVersionResponseSchema,
  SkillVersionIdParamSchema,
} from '../../schemas/skillMarketPublic';

/**
 * Skill Market review over an API key: the `/api/v1` twins of GET /api/skills/market/review-queue
 * (pending filter only) and POST /api/skills/market/versions/[vid]/review (approve and reject only).
 * Both share their logic with the SPA routes (server/skillMarket/reviewQueue.ts, submitVersion.ts).
 * A key without `admin:*` never carries the platform-admin role, so under one only org admins can
 * review, and only their organizations' Organization listings.
 */

const SCOPES = [ApiKeyScope.SKILLS_REVIEW];
const KEY_429 = 'Per-key rate limit exceeded.';

export const listSkillMarketReviewQueueContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/skills/market/review-queue',
  operationId: 'listSkillMarketReviewQueue',
  summary: 'List Skill Market versions awaiting review',
  description:
    'Lists the held versions you can review, oldest first, each with its listing and the approved version it ' +
    'would replace. Under an API key without `admin:*` this is the Organization listings of the organizations ' +
    'you administer. ' +
    'Cursor-paginated, but a page can be shorter than `limit`, even empty, while `next_cursor` is non-null: ' +
    'keep passing `next_cursor` back as `cursor` until it is `null`. A version that finishes scanning after ' +
    'you paged past its creation time shows up on the next pass that starts without a cursor.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  queryParams: ReviewQueueQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of the review queue.', schema: ReviewQueueResponseSchema },
    403: {
      description: 'The API key lacks `skills:review`, or you administer no organization.',
      schema: ScopeForbiddenErrorSchema,
    },
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

const APPROVE_EXAMPLE = { action: 'approve', ack_high_risk: true };

export const reviewSkillMarketVersionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/skills/market/versions/{vid}/review',
  operationId: 'reviewSkillMarketVersion',
  summary: 'Approve or reject a held Skill Market version',
  description:
    'Approving puts the version live for importers; rejecting keeps the earlier approved version live and ' +
    'needs a `note` for the author.',
  tags: ['Skills'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: SkillVersionIdParamSchema,
  request: ReviewSkillVersionRequestSchema,
  requestExample: APPROVE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The decided version.', schema: ReviewSkillVersionResponseSchema },
    400: { description: 'Approval needs `ack_high_risk` or `ack_mismatch`.', schema: ApiErrorSchema },
    403: {
      description:
        'The API key lacks `skills:review`, or you may not review this listing: it is not an Organization ' +
        'listing of an organization you administer, or it is your own Public listing.',
      schema: ScopeForbiddenErrorSchema,
    },
    404: { description: 'No version with that id exists, or its listing is gone.', schema: ApiErrorSchema },
    409: {
      description: 'The version is no longer awaiting review: it was decided or superseded.',
      schema: ApiErrorSchema,
    },
    422: { description: 'The body is invalid, e.g. a reject without a `note`.', schema: ApiErrorSchema },
    429: { description: KEY_429, schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: APPROVE_EXAMPLE },
});
