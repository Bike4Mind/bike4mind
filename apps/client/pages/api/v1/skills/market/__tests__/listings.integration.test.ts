// @vitest-environment node
/**
 * The /api/v1 Skill Market authoring routes through the REAL baseApi chain (apiKeyAuth and the scope
 * gate included), with the shared domain functions (server/skillMarket/author.ts, importListing.ts,
 * search.ts, detail.ts) mocked: their behaviour is covered by the SPA routes' tests and
 * server/skillMarket/skillMarket.e2e.test.ts. What is proven here is the v1 layer: each contract's
 * scopes reach the gate, JWT still works, and every body renders as the contract's snake_case schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  findUser: vi.fn(),
  keyRateLimit: vi.fn(),
  memberOrgs: vi.fn(),
  findListing: vi.fn(),
  search: vi.fn(),
  detail: vi.fn(),
  publish: vi.fn(),
  submit: vi.fn(),
  rescan: vi.fn(),
  withdraw: vi.fn(),
  mine: vi.fn(),
  importListing: vi.fn(),
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
// A JWT caller is the one with `Authorization: Bearer jwt`; anyone else without a key is a 401.
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (req: any, res: any, next: any) => {
    if (req.user) return next();
    if (req.headers.authorization !== 'Bearer jwt') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false };
    next();
  },
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  memberOrgIdsFor: (...a: unknown[]) => h.memberOrgs(...a),
  findListing: (...a: unknown[]) => h.findListing(...a),
  enforceSubmitRateLimits: async () => undefined,
}));
vi.mock('@server/skillMarket/search', () => ({ searchListings: (...a: unknown[]) => h.search(...a) }));
vi.mock('@server/skillMarket/detail', () => ({ buildListingDetail: (...a: unknown[]) => h.detail(...a) }));
vi.mock('@server/skillMarket/author', () => ({
  publishListing: (...a: unknown[]) => h.publish(...a),
  submitNewVersion: (...a: unknown[]) => h.submit(...a),
  rescanOwnVersion: (...a: unknown[]) => h.rescan(...a),
  withdrawOwnListing: (...a: unknown[]) => h.withdraw(...a),
  listMyListings: (...a: unknown[]) => h.mine(...a),
}));
vi.mock('@server/skillMarket/importListing', () => ({ importListing: (...a: unknown[]) => h.importListing(...a) }));

import {
  ApiKeyScope,
  BrowseSkillListingsResponseSchema,
  ConcurrencyConflictError,
  ConflictError,
  ImportSkillListingResponseSchema,
  MySkillListingsResponseSchema,
  RescanSkillVersionResponseSchema,
  SkillListingDetailSchema,
  SkillMarketSubmitResponseSchema,
  type ISkillListing,
  type ISkillListingVersion,
} from '@bike4mind/common';
import { serializeListing } from '@bike4mind/server-utils/skillMarket/market';
import { encodeCursor } from '@server/utils/cursorPagination';
import listingsHandler from '../listings/index';
import mineHandler from '../listings/mine';
import byIdHandler from '../listings/[id]/index';
import versionsHandler from '../listings/[id]/versions';
import importHandler from '../listings/[id]/import';
import rescanHandler from '../versions/[vid]/rescan';

const LISTING_ID = '65a000000000000000000001';
const VERSION_ID = '65a000000000000000000002';
const ORG_ID = '65a0000000000000000000aa';
const CREATED = new Date('2026-01-01T00:00:00.000Z');

const LISTING: ISkillListing = {
  id: LISTING_ID,
  sourceSkillId: 'skill-1',
  authorUserId: 'user-1',
  authorName: 'Ada',
  visibility: 'organization',
  organizationId: ORG_ID,
  tags: ['review'],
  status: 'approved',
  shareToken: 'secret-share-token',
  currentApprovedVersionId: VERSION_ID,
  currentVersion: 1,
  pendingVersionId: null,
  pendingVersion: null,
  latestVersion: 1,
  name: 'review-pr',
  description: 'Review a pull request.',
  usesTools: true,
  riskTier: 'clean',
  autoChecked: true,
  publishedAt: CREATED,
  importCount: 2,
  ratingSum: 9,
  ratingCount: 2,
  createdAt: CREATED,
  updatedAt: CREATED,
  deletedAt: null,
};

const VERSION: ISkillListingVersion = {
  id: VERSION_ID,
  listingId: LISTING_ID,
  version: 1,
  snapshot: {
    name: 'review-pr',
    description: 'Review a pull request.',
    body: 'Do the review.',
    allowedTools: ['Read'],
  },
  contentHash: 'hash',
  scanStatus: 'passed',
  scanFindings: [{ rule: 'tool-use', severity: 'low', message: 'Reads files', source: 'rules' }],
  riskTier: 'clean',
  honestSummary: {
    whatItDoes: 'Reviews a PR',
    toolsUsed: ['Read'],
    dataItTouches: 'The diff',
    riskNotes: [],
    descriptionMatches: true,
  },
  reviewStatus: 'auto_approved',
  createdAt: CREATED,
  updatedAt: CREATED,
};

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
type FireInit = { method: 'GET' | 'POST' | 'DELETE'; url: string; query?: object; body?: object };

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, init: FireInit, caller: Caller = 'key') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (caller === 'key') headers['x-api-key'] = 'sk-test-valid-key';
  if (caller === 'jwt') headers.authorization = 'Bearer jwt';
  const { req, res } = createMocks({ ...init, headers } as never, { eventEmitter: EventEmitter });
  await handler(req, res);
  return res;
}

const byId = { id: LISTING_ID };
const ROUTES = {
  browse: (c?: Caller) => fire(listingsHandler, { method: 'GET', url: '/api/v1/skills/market/listings' }, c),
  detail: (c?: Caller) =>
    fire(byIdHandler, { method: 'GET', url: `/api/v1/skills/market/listings/${LISTING_ID}`, query: byId }, c),
  publish: (c?: Caller) =>
    fire(
      listingsHandler,
      {
        method: 'POST',
        url: '/api/v1/skills/market/listings',
        body: { skill_id: 'skill-1', visibility: 'organization', organization_id: ORG_ID },
      },
      c
    ),
  mine: (c?: Caller) => fire(mineHandler, { method: 'GET', url: '/api/v1/skills/market/listings/mine' }, c),
  withdraw: (c?: Caller) =>
    fire(byIdHandler, { method: 'DELETE', url: `/api/v1/skills/market/listings/${LISTING_ID}`, query: byId }, c),
  versions: (c?: Caller) =>
    fire(
      versionsHandler,
      { method: 'POST', url: `/api/v1/skills/market/listings/${LISTING_ID}/versions`, query: byId, body: {} },
      c
    ),
  import: (c?: Caller) =>
    fire(
      importHandler,
      { method: 'POST', url: `/api/v1/skills/market/listings/${LISTING_ID}/import`, query: byId, body: {} },
      c
    ),
  rescan: (c?: Caller) =>
    fire(
      rescanHandler,
      { method: 'POST', url: `/api/v1/skills/market/versions/${VERSION_ID}/rescan`, query: { vid: VERSION_ID } },
      c
    ),
};
type RouteName = keyof typeof ROUTES;

beforeEach(() => {
  vi.clearAllMocks();
  h.findUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isBanned: false,
    disputePending: false,
  });
  h.keyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  h.memberOrgs.mockResolvedValue([ORG_ID]);
  h.findListing.mockResolvedValue(LISTING);
  h.search.mockResolvedValue({ data: [serializeListing(LISTING)], hasMore: false });
  h.detail.mockResolvedValue({
    listing: serializeListing(LISTING),
    version: { id: VERSION_ID, version: 1, snapshot: VERSION.snapshot, riskTier: 'clean', createdAt: CREATED },
    ratings: [{ stars: 5, review: 'Great', ratedAt: CREATED, mine: false }],
    myImport: null,
    viewer: { isAuthor: false, canReview: false, canDelist: false, canRestore: false, canImport: true, canRate: false },
    similar: [],
  });
  h.publish.mockResolvedValue({ listing: LISTING, version: VERSION });
  h.submit.mockResolvedValue({ listing: LISTING, version: VERSION });
  h.rescan.mockResolvedValue(VERSION);
  h.withdraw.mockResolvedValue(undefined);
  h.mine.mockResolvedValue({ listings: [{ listing: LISTING, versions: [VERSION] }], next: null });
  h.importListing.mockResolvedValue({ skill: { id: 'copy-1', name: 'review-pr' }, created: true });
});

const DOMAIN_CALL: Record<RouteName, ReturnType<typeof vi.fn>> = {
  browse: h.search,
  detail: h.detail,
  publish: h.publish,
  mine: h.mine,
  withdraw: h.withdraw,
  versions: h.submit,
  import: h.importListing,
  rescan: h.rescan,
};

// [route, success status, a scope that must be refused, the contract's accepted scopes]
const MATRIX: [RouteName, number, ApiKeyScope, ApiKeyScope[]][] = [
  ['browse', 200, ApiKeyScope.READ_AGENTS, [ApiKeyScope.SKILLS_READ, ApiKeyScope.SKILLS_WRITE]],
  ['detail', 200, ApiKeyScope.READ_AGENTS, [ApiKeyScope.SKILLS_READ, ApiKeyScope.SKILLS_WRITE]],
  ['publish', 201, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['mine', 200, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['withdraw', 204, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['versions', 201, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['import', 201, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
  ['rescan', 200, ApiKeyScope.SKILLS_READ, [ApiKeyScope.SKILLS_WRITE]],
];

describe('/api/v1/skills/market scope enforcement (real middleware chain)', () => {
  it.each(MATRIX)('%s: a skills:write key succeeds (%i)', async (route, status) => {
    withScopes([ApiKeyScope.SKILLS_WRITE]);
    expect((await ROUTES[route]())._getStatusCode()).toBe(status);
  });

  it.each(MATRIX)(
    '%s: a %s-less key with %s is refused (403) before the domain call',
    async (route, _s, wrong, accepted) => {
      withScopes([wrong]);
      const res = await ROUTES[route]();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual(accepted);
      expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
    }
  );

  it.each(MATRIX)('%s: an invalid key is a 401', async route => {
    h.validate.mockResolvedValue({ isValid: false });
    expect((await ROUTES[route]())._getStatusCode()).toBe(401);
    expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: no credential is a 401', async route => {
    expect((await ROUTES[route]('none'))._getStatusCode()).toBe(401);
    expect(DOMAIN_CALL[route]).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: a JWT caller still succeeds (%i)', async (route, status) => {
    expect((await ROUTES[route]('jwt'))._getStatusCode()).toBe(status);
  });

  it('a confined skills:read key can browse and read a listing', async () => {
    withScopes([ApiKeyScope.SKILLS_READ]);
    expect((await ROUTES.browse())._getStatusCode()).toBe(200);
    expect((await ROUTES.detail())._getStatusCode()).toBe(200);
  });
});

describe('/api/v1/skills/market wire shapes', () => {
  beforeEach(() => withScopes([ApiKeyScope.SKILLS_WRITE]));

  it('publish renders the listing and version as snake_case, with the author-only fields', async () => {
    const res = await ROUTES.publish();
    const body = SkillMarketSubmitResponseSchema.strict().parse(res._getJSONData());
    expect(body.listing).toEqual({
      id: LISTING_ID,
      name: 'review-pr',
      description: 'Review a pull request.',
      visibility: 'organization',
      organization_id: ORG_ID,
      tags: ['review'],
      status: 'approved',
      author_name: 'Ada',
      current_version: 1,
      risk_tier: 'clean',
      uses_tools: true,
      auto_checked: true,
      import_count: 2,
      rating_avg: 4.5,
      rating_count: 2,
      published_at: CREATED.toISOString(),
      created_at: CREATED.toISOString(),
      updated_at: CREATED.toISOString(),
      source_skill_id: 'skill-1',
      share_token: 'secret-share-token',
      latest_version: 1,
      pending_version: null,
    });
    expect(body.version).toMatchObject({
      id: VERSION_ID,
      version: 1,
      scan_status: 'passed',
      review_status: 'auto_approved',
      review_note: null,
      scan_findings: [{ rule: 'tool-use', severity: 'low', message: 'Reads files', excerpt: null, source: 'rules' }],
      honest_summary: { what_it_does: 'Reviews a PR', mismatch_note: null },
      snapshot: { body: 'Do the review.', allowed_tools: ['Read'], argument_hint: null },
    });
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      { skillId: 'skill-1', visibility: 'organization', organizationId: ORG_ID, tags: undefined },
      expect.anything()
    );
  });

  it('publish defaults organization_id when the caller is in exactly one organization', async () => {
    await fire(listingsHandler, {
      method: 'POST',
      url: '/api/v1/skills/market/listings',
      body: { skill_id: 'skill-1', visibility: 'organization' },
    });
    expect(h.publish.mock.calls[0][1]).toMatchObject({ organizationId: ORG_ID });
  });

  it('publish leaves organization_id unset for a caller in several organizations', async () => {
    h.memberOrgs.mockResolvedValue([ORG_ID, '65a0000000000000000000bb']);
    await fire(listingsHandler, {
      method: 'POST',
      url: '/api/v1/skills/market/listings',
      body: { skill_id: 'skill-1', visibility: 'organization' },
    });
    expect(h.publish.mock.calls[0][1]).toMatchObject({ organizationId: undefined });
  });

  it('publish leaves organization_id unset for a caller in no organization', async () => {
    h.memberOrgs.mockResolvedValue([]);
    await fire(listingsHandler, {
      method: 'POST',
      url: '/api/v1/skills/market/listings',
      body: { skill_id: 'skill-1', visibility: 'organization' },
    });
    expect(h.publish.mock.calls[0][1]).toMatchObject({ organizationId: undefined });
  });

  it("publish rejects the SPA route's camelCase body (422)", async () => {
    const res = await fire(listingsHandler, {
      method: 'POST',
      url: '/api/v1/skills/market/listings',
      body: { skillId: 'skill-1', visibility: 'public' },
    });
    expect(res._getStatusCode()).toBe(422);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('publish passes a 409 from the shared logic through', async () => {
    h.publish.mockRejectedValue(new ConflictError('This skill already has a listing.'));
    const res = await ROUTES.publish();
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().error).toBe('This skill already has a listing.');
  });

  it('browse hides author-only fields and pages with an opaque cursor', async () => {
    h.search.mockResolvedValueOnce({ data: [serializeListing(LISTING)], hasMore: true });
    const first = await fire(listingsHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings',
      query: { q: 'review', tags: 'Review, ci', limit: '10' },
    });
    const page1 = BrowseSkillListingsResponseSchema.parse(first._getJSONData());
    expect(page1.data[0]).not.toHaveProperty('share_token');
    expect(page1.data[0]).not.toHaveProperty('source_skill_id');
    expect(h.search).toHaveBeenLastCalledWith(
      [ORG_ID],
      expect.objectContaining({ page: 1, limit: 10, sort: 'relevance', tags: ['review', 'ci'] })
    );
    expect(page1.next_cursor).toEqual(expect.any(String));

    const second = await fire(listingsHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings',
      query: { q: 'review', limit: '10', cursor: page1.next_cursor },
    });
    expect(second._getJSONData().next_cursor).toBeNull();
    expect(h.search).toHaveBeenLastCalledWith([ORG_ID], expect.objectContaining({ page: 2, limit: 10 }));
  });

  it('browse rejects a malformed cursor and an over-cap limit (422)', async () => {
    for (const query of [{ cursor: 'not-a-cursor' }, { limit: '51' }]) {
      const res = await fire(listingsHandler, { method: 'GET', url: '/api/v1/skills/market/listings', query });
      expect(res._getStatusCode()).toBe(422);
    }
    expect(h.search).not.toHaveBeenCalled();
  });

  it('mine filters by source_skill_id and round-trips its keyset cursor', async () => {
    h.mine.mockResolvedValueOnce({
      listings: [{ listing: LISTING, versions: [VERSION] }],
      next: { at: CREATED, id: LISTING_ID },
    });
    const first = await fire(mineHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings/mine',
      query: { source_skill_id: 'skill-1', limit: '1' },
    });
    const page1 = MySkillListingsResponseSchema.parse(first._getJSONData());
    expect(page1.data[0]).toMatchObject({ source_skill_id: 'skill-1', versions: [{ id: VERSION_ID }] });
    expect(h.mine).toHaveBeenLastCalledWith('user-1', { limit: 1, after: undefined, sourceSkillId: 'skill-1' });

    await fire(mineHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings/mine',
      query: { cursor: page1.next_cursor },
    });
    expect(h.mine).toHaveBeenLastCalledWith('user-1', {
      limit: 25,
      after: { at: CREATED, id: LISTING_ID },
      sourceSkillId: undefined,
    });
  });

  it('detail renders the approved version without scan internals', async () => {
    const res = await ROUTES.detail();
    const body = SkillListingDetailSchema.parse(res._getJSONData());
    expect(body.listing).not.toHaveProperty('share_token');
    expect(body.version).not.toHaveProperty('scan_status');
    expect(body.ratings).toEqual([{ stars: 5, review: 'Great', rated_at: CREATED.toISOString(), mine: false }]);
    expect(body.my_import).toBeNull();
  });

  it('detail renders the Claude Code tools and supporting files', async () => {
    const files = [{ path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n' }];
    h.detail.mockResolvedValueOnce({
      ...(await h.detail()),
      version: {
        id: VERSION_ID,
        version: 1,
        snapshot: { ...VERSION.snapshot, claudeCodeAllowedTools: ['Bash(git:*)'], files },
        riskTier: 'clean',
        createdAt: CREATED,
      },
    });
    const body = SkillListingDetailSchema.parse((await ROUTES.detail())._getJSONData());
    expect(body.version?.snapshot).toMatchObject({ claude_code_allowed_tools: ['Bash(git:*)'], files });
  });

  it('detail renders a skill with no supporting files as an empty list', async () => {
    const body = SkillListingDetailSchema.parse((await ROUTES.detail())._getJSONData());
    expect(body.version?.snapshot).toMatchObject({ claude_code_allowed_tools: [], files: [] });
  });

  it('mine omits files along with the body of a version preview', async () => {
    const { body: _body, ...bodiless } = VERSION.snapshot;
    h.mine.mockResolvedValueOnce({
      listings: [{ listing: LISTING, versions: [{ ...VERSION, snapshot: bodiless }] }],
      next: null,
    });
    const res = await fire(mineHandler, { method: 'GET', url: '/api/v1/skills/market/listings/mine', query: {} });
    const [version] = MySkillListingsResponseSchema.parse(res._getJSONData()).data[0].versions;
    expect(version.snapshot).not.toHaveProperty('body');
    expect(version.snapshot).not.toHaveProperty('files');
  });

  it.each([
    ['a skills:write key', 'key', [ApiKeyScope.SKILLS_WRITE], true],
    ['a JWT', 'jwt', [], true],
    ['a skills:read key', 'key', [ApiKeyScope.SKILLS_READ], false],
  ] as const)("detail gives the author's share token to %s: %s", async (_label, caller, scopes, shown) => {
    withScopes([...scopes]);
    h.detail.mockResolvedValue({
      ...(await h.detail()),
      listing: serializeListing(LISTING, { privileged: true }),
      viewer: {
        isAuthor: true,
        canReview: false,
        canDelist: false,
        canRestore: false,
        canImport: true,
        canRate: false,
      },
    });
    const body = SkillListingDetailSchema.parse((await ROUTES.detail(caller))._getJSONData());
    expect(body.listing.share_token === 'secret-share-token').toBe(shown);
    expect('source_skill_id' in body.listing).toBe(shown);
  });

  it('browse rejects a well-formed cursor for an out-of-range page (422)', async () => {
    for (const page of ['1', 'abc', '1e300', '1001']) {
      const res = await fire(listingsHandler, {
        method: 'GET',
        url: '/api/v1/skills/market/listings',
        query: { cursor: encodeCursor('v1.skills.market.listings', page) },
      });
      expect(res._getStatusCode()).toBe(422);
    }
    expect(h.search).not.toHaveBeenCalled();
  });

  it('browse rejects a cursor reused with a different limit (422)', async () => {
    h.search.mockResolvedValueOnce({ data: [serializeListing(LISTING)], hasMore: true });
    const first = await fire(listingsHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings',
      query: { limit: '1' },
    });
    const res = await fire(listingsHandler, {
      method: 'GET',
      url: '/api/v1/skills/market/listings',
      query: { limit: '2', cursor: first._getJSONData().next_cursor },
    });
    expect(res._getStatusCode()).toBe(422);
    expect(h.search).toHaveBeenCalledTimes(1);
  });

  it('detail answers 404 for an unknown listing', async () => {
    h.findListing.mockResolvedValue(null);
    expect((await ROUTES.detail())._getStatusCode()).toBe(404);
  });

  it('new version, rescan and import render their contract shapes', async () => {
    SkillMarketSubmitResponseSchema.parse((await ROUTES.versions())._getJSONData());
    RescanSkillVersionResponseSchema.parse((await ROUTES.rescan())._getJSONData());
    expect(ImportSkillListingResponseSchema.parse((await ROUTES.import())._getJSONData())).toEqual({
      skill: { id: 'copy-1', name: 'review-pr' },
    });
  });

  it('a bodiless new-version POST is accepted', async () => {
    const res = await fire(versionsHandler, {
      method: 'POST',
      url: `/api/v1/skills/market/listings/${LISTING_ID}/versions`,
      query: byId,
    });
    expect(res._getStatusCode()).toBe(201);
    expect(h.submit).toHaveBeenCalledWith(expect.anything(), LISTING_ID, undefined, expect.anything());
  });

  it('import refreshing an earlier copy answers 200', async () => {
    h.importListing.mockResolvedValue({ skill: { id: 'copy-1', name: 'review-pr' }, created: false });
    const res = await fire(importHandler, {
      method: 'POST',
      url: `/api/v1/skills/market/listings/${LISTING_ID}/import`,
      query: byId,
      body: { target_skill_id: 'copy-1', overwrite: true },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(h.importListing).toHaveBeenCalledWith(expect.anything(), LISTING_ID, {
      token: undefined,
      name: undefined,
      targetSkillId: 'copy-1',
      overwrite: true,
      expectedVersionId: undefined,
    });
  });

  it("import publishes the shared logic's 409 `code` as `errorCode`", async () => {
    h.importListing.mockRejectedValue(
      new ConflictError('You already have a skill named "review-pr"', {
        code: 'name_taken',
        suggestedName: 'review-pr-2',
      })
    );
    const res = await ROUTES.import();
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'name_taken', suggested_name: 'review-pr-2' });
    expect(res._getJSONData()).not.toHaveProperty('code');
  });

  it('import turns a lost write race into a plain 409 without its internals', async () => {
    h.importListing.mockRejectedValue(new ConcurrencyConflictError('Skill', { filter: { _id: 'x' }, reason: 'r' }));
    const res = await ROUTES.import();
    expect(res._getStatusCode()).toBe(409);
    expect(JSON.stringify(res._getJSONData())).not.toMatch(/filter|reason/);
  });

  it('withdraw passes the listing id to the shared logic', async () => {
    expect((await ROUTES.withdraw())._getStatusCode()).toBe(204);
    expect(h.withdraw).toHaveBeenCalledWith('user-1', LISTING_ID);
  });
});
