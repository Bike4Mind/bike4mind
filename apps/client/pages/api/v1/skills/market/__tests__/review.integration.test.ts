// @vitest-environment node
/**
 * The /api/v1 Skill Market review routes through the REAL baseApi chain (apiKeyAuth, which withholds
 * isAdmin under a key, and the scope gate). The queue loader and decideVersion are mocked: their
 * behaviour is covered by server/skillMarket/reviewQueue.e2e.test.ts and skillMarket.e2e.test.ts. The
 * mocked decideVersion keeps the real canReviewListing gate, so the Public-listing 403 is the real rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  findUser: vi.fn(),
  keyRateLimit: vi.fn(),
  adminOrgs: vi.fn(),
  queue: vi.fn(),
  decide: vi.fn(),
  jwtIsAdmin: false,
  // The listing the mocked decideVersion gates on; LISTING when unset.
  decideListing: undefined as unknown,
}));

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => h.keyRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => h.validate(...a),
    },
  };
});
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => h.findUser(...a),
      updateMany: vi.fn().mockResolvedValue(undefined),
    }),
    userRepository: { findById: (...a: unknown[]) => h.findUser(...a) },
  };
});
vi.mock('@bike4mind/database/infra', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  organizationRepository: { findIdsAdministeredBy: (...a: unknown[]) => h.adminOrgs(...a) },
}));
// A JWT caller is the one with `Authorization: Bearer jwt`; anyone else without a key is a 401.
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (req: any, res: any, next: any) => {
    if (req.user) return next();
    if (req.headers.authorization !== 'Bearer jwt') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user-1', _id: 'user-1', groups: [], isAdmin: h.jwtIsAdmin, isBanned: false };
    next();
  },
}));
vi.mock('@server/skillMarket/reviewQueue', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  loadVersionQueue: (...a: unknown[]) => h.queue(...a),
}));
vi.mock('@server/skillMarket/submitVersion', () => ({ decideVersion: (...a: unknown[]) => h.decide(...a) }));

import {
  ApiKeyScope,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ReviewQueueResponseSchema,
  ReviewSkillVersionResponseSchema,
  type ISkillListing,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { canReviewListing, type MarketActor } from '@bike4mind/server-utils/skillMarket/market';
import { encodeTimeIdCursor } from '@server/utils/cursorPagination';
import queueHandler from '../review-queue';
import reviewHandler from '../versions/[vid]/review';

const LISTING_ID = '65a000000000000000000001';
const VERSION_ID = '65a000000000000000000002';
const PREV_ID = '65a000000000000000000003';
const ORG_ID = '65a0000000000000000000aa';
const CREATED = new Date('2026-01-01T00:00:00.000Z');

const LISTING: ISkillListing = {
  id: LISTING_ID,
  sourceSkillId: 'skill-1',
  authorUserId: 'author-1',
  authorName: 'Ada',
  visibility: 'organization',
  organizationId: ORG_ID,
  tags: ['review'],
  status: 'approved',
  shareToken: 'secret-share-token',
  currentApprovedVersionId: PREV_ID,
  currentVersion: 1,
  pendingVersionId: VERSION_ID,
  pendingVersion: 2,
  latestVersion: 2,
  name: 'review-pr',
  description: 'Review a pull request.',
  usesTools: true,
  riskTier: 'high',
  autoChecked: false,
  publishedAt: CREATED,
  importCount: 2,
  ratingSum: 9,
  ratingCount: 2,
  createdAt: CREATED,
  updatedAt: CREATED,
  deletedAt: null,
};
const PUBLIC_LISTING: ISkillListing = { ...LISTING, visibility: 'public', organizationId: undefined };

const VERSION: ISkillListingVersion = {
  id: VERSION_ID,
  listingId: LISTING_ID,
  version: 2,
  snapshot: { name: 'review-pr', description: 'Review a pull request.', body: 'Do it.', allowedTools: ['Bash'] },
  contentHash: 'hash',
  scanStatus: 'passed',
  scanFindings: [{ rule: 'shell', severity: 'high', message: 'Runs shell', source: 'rules' }],
  riskTier: 'high',
  honestSummary: {
    whatItDoes: 'Reviews a PR',
    toolsUsed: ['Bash'],
    dataItTouches: 'The diff',
    riskNotes: ['Runs shell'],
    descriptionMatches: true,
  },
  reviewStatus: 'pending',
  createdAt: CREATED,
  updatedAt: CREATED,
};

const queueRow = (listing: ISkillListing = LISTING) => ({
  version: { toJSON: () => VERSION },
  listing,
  previous: { id: PREV_ID, version: 1, snapshot: { name: 'review-pr', description: 'Older.', body: 'Old.' } },
  canDecide: true,
});

function withScopes(scopes: ApiKeyScope[]) {
  h.validate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

type Caller = 'key' | 'jwt' | 'none';

// any: the handlers' Express-typed params vs node-mocks-http mocks.

async function fire(
  handler: any,
  init: { method: 'GET' | 'POST'; url: string; query?: object; body?: object },
  caller: Caller = 'key'
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (caller === 'key') headers['x-api-key'] = 'sk-test-valid-key';
  if (caller === 'jwt') headers.authorization = 'Bearer jwt';
  const { req, res } = createMocks({ ...init, headers } as never, { eventEmitter: EventEmitter });
  await handler(req, res);
  return res;
}

const getQueue = (query: object = {}, c?: Caller) =>
  fire(queueHandler, { method: 'GET', url: '/api/v1/skills/market/review-queue', query }, c);
const review = (body: object, c?: Caller) =>
  fire(
    reviewHandler,
    { method: 'POST', url: `/api/v1/skills/market/versions/${VERSION_ID}/review`, query: { vid: VERSION_ID }, body },
    c
  );
const ROUTES = {
  queue: (c?: Caller) => getQueue({}, c),
  review: (c?: Caller) => review({ action: 'approve', ack_high_risk: true }, c),
};
type RouteName = keyof typeof ROUTES;
const DOMAIN_CALL: Record<RouteName, ReturnType<typeof vi.fn>> = { queue: h.queue, review: h.decide };

/** The owner's stored role; apiKeyAuth withholds it under any key without admin:*. */
function ownerIsAdmin(isAdmin: boolean) {
  h.jwtIsAdmin = isAdmin;
  h.findUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isAdmin,
    isBanned: false,
    disputePending: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ownerIsAdmin(false);
  h.keyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  h.adminOrgs.mockResolvedValue([ORG_ID]);
  h.queue.mockResolvedValue({ rows: [queueRow()], next: null });
  // The real review gate over the given listing; the CAS writes are the e2e suite's concern.
  h.decide.mockImplementation(
    async (_vid: string, actor: MarketActor, orgIds: string[], decision: { action: string }) => {
      const listing = (h.decideListing as ISkillListing | undefined) ?? LISTING;
      if (!canReviewListing(listing, actor, orgIds)) throw new ForbiddenError("You don't have permission");
      return { ...VERSION, reviewStatus: decision.action === 'approve' ? 'approved' : 'rejected' };
    }
  );
  h.decideListing = undefined;
});

// [route, success status, a scope that must be refused]
const MATRIX: [RouteName, number, ApiKeyScope][] = [
  ['queue', 200, ApiKeyScope.SKILLS_WRITE],
  ['review', 200, ApiKeyScope.SKILLS_WRITE],
];

describe('/api/v1/skills/market review scope enforcement (real middleware chain)', () => {
  it.each(MATRIX)('%s: an org admin with a skills:review key succeeds (%i)', async (route, status) => {
    withScopes([ApiKeyScope.SKILLS_REVIEW]);
    expect((await ROUTES[route]())._getStatusCode()).toBe(status);
  });

  it.each(MATRIX)('%s: a key with only %s is refused (403) before the domain call', async (route, _s, wrong) => {
    withScopes([wrong]);
    const res = await ROUTES[route]();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.SKILLS_REVIEW]);
    expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: no credential is a 401', async route => {
    expect((await ROUTES[route]('none'))._getStatusCode()).toBe(401);
    expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: a JWT caller still succeeds (%i)', async (route, status) => {
    expect((await ROUTES[route]('jwt'))._getStatusCode()).toBe(status);
  });
});

describe('/api/v1/skills/market/review-queue', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_REVIEW]));

  it('renders the pending queue as snake_case with the privileged version and listing', async () => {
    const res = await getQueue();
    const body = ReviewQueueResponseSchema.parse(res._getJSONData());
    expect(body.next_cursor).toBeNull();
    expect(body.data).toHaveLength(1);
    const [item] = body.data;
    expect(item.can_decide).toBe(true);
    expect(item.previous).toEqual({
      id: PREV_ID,
      version: 1,
      snapshot: {
        name: 'review-pr',
        description: 'Older.',
        body: 'Old.',
        argument_hint: null,
        allowed_tools: [],
        claude_code_allowed_tools: [],
        disable_model_invocation: false,
      },
    });
    expect(item.version).toMatchObject({
      id: VERSION_ID,
      risk_tier: 'high',
      scan_status: 'passed',
      review_status: 'pending',
      scan_findings: [{ rule: 'shell', severity: 'high', message: 'Runs shell', excerpt: null, source: 'rules' }],
      honest_summary: { description_matches: true },
      snapshot: { body: 'Do it.' },
    });
    expect(item.listing).toMatchObject({ id: LISTING_ID, organization_id: ORG_ID, pending_version: 2 });
    expect(h.queue).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, [ORG_ID], {
      filter: 'pending',
      limit: 25,
      after: undefined,
    });
  });

  it('withholds a platform admin role under a key, but not over JWT', async () => {
    ownerIsAdmin(true);
    await getQueue();
    expect(h.queue.mock.calls[0][0]).toEqual({ id: 'user-1', isAdmin: false });
    await getQueue({}, 'jwt');
    expect(h.queue.mock.calls[1][0]).toEqual({ id: 'user-1', isAdmin: true });
  });

  it('refuses a key holder who administers no organization (403), even a platform admin', async () => {
    ownerIsAdmin(true);
    h.adminOrgs.mockResolvedValue([]);
    const res = await getQueue();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('Reviewers only');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('round-trips the cursor, and serves an empty page that still has a next cursor', async () => {
    const at = new Date('2026-02-01T00:00:00.000Z');
    h.queue.mockResolvedValueOnce({ rows: [], next: { at, id: VERSION_ID } });
    const first = ReviewQueueResponseSchema.parse((await getQueue({ limit: '1' }))._getJSONData());
    expect(first.data).toEqual([]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await getQueue({ limit: '1', cursor: first.next_cursor });
    expect(second._getStatusCode()).toBe(200);
    expect(h.queue.mock.calls[1][2]).toEqual({ filter: 'pending', limit: 1, after: { at, id: VERSION_ID } });
  });

  it.each(['0', '101'])('rejects limit=%s (422)', async limit => {
    expect((await getQueue({ limit }))._getStatusCode()).toBe(422);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor or another endpoint's cursor (422)", async () => {
    expect((await getQueue({ cursor: 'nope' }))._getStatusCode()).toBe(422);
    const foreign = encodeTimeIdCursor('v1.skills.market.listings.mine', { at: CREATED, id: VERSION_ID });
    expect((await getQueue({ cursor: foreign }))._getStatusCode()).toBe(422);
    expect(h.queue).not.toHaveBeenCalled();
  });
});

describe('/api/v1/skills/market/versions/{vid}/review', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_REVIEW]));

  it("approves the org's Organization listing version, mapping the acks to the shared decision", async () => {
    const res = await review({ action: 'approve', ack_high_risk: true, ack_mismatch: false, note: ' ok ' });
    const body = ReviewSkillVersionResponseSchema.parse(res._getJSONData());
    expect(body.version).toMatchObject({ id: VERSION_ID, review_status: 'approved', scan_status: 'passed' });
    expect(h.decide).toHaveBeenCalledWith(VERSION_ID, { id: 'user-1', isAdmin: false }, [ORG_ID], {
      action: 'approve',
      ackHighRisk: true,
      ackMismatch: false,
      note: 'ok',
    });
  });

  it('rejects with a note', async () => {
    const res = await review({ action: 'reject', note: 'Runs arbitrary shell.' });
    expect(ReviewSkillVersionResponseSchema.parse(res._getJSONData()).version.review_status).toBe('rejected');
    expect(h.decide.mock.calls[0][3]).toEqual({ action: 'reject', note: 'Runs arbitrary shell.' });
  });

  it("refuses a platform admin's key on a Public listing (403): isAdmin is withheld", async () => {
    ownerIsAdmin(true);
    h.decideListing = PUBLIC_LISTING;
    const res = await review({ action: 'approve', ack_high_risk: true });
    expect(res._getStatusCode()).toBe(403);
    // The same owner over JWT is a platform admin and may decide it.
    expect((await review({ action: 'approve', ack_high_risk: true }, 'jwt'))._getStatusCode()).toBe(200);
  });

  it.each([
    ['reject without a note', { action: 'reject' }],
    ['reject with a blank note', { action: 'reject', note: '   ' }],
    ['audit, which v1 does not expose', { action: 'audit' }],
    ["the SPA route's camelCase ack", { action: 'approve', ackHighRisk: true }],
  ])('refuses %s (422) before the domain call', async (_name, body) => {
    expect((await review(body))._getStatusCode()).toBe(422);
    expect(h.decide).not.toHaveBeenCalled();
  });

  it.each([
    [400, new BadRequestError('Acknowledge the high-risk findings before approving')],
    [404, new NotFoundError('Version not found')],
    [409, new ConflictError('This version was superseded or already decided')],
  ])('passes a %i from the shared logic through', async (status, error) => {
    h.decide.mockRejectedValue(error);
    const res = await review({ action: 'approve' });
    expect(res._getStatusCode()).toBe(status);
    expect(res._getJSONData().error).toBe(error.message);
  });
});
