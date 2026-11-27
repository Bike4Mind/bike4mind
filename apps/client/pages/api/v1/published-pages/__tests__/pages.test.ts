// @vitest-environment node
/**
 * /api/v1/published-pages management routes through the REAL baseApi chain: statuses, response shapes
 * against the contract schemas, the camelCase service mapping and the 404-for-not-yours rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockCreateUpload,
  mockFinalize,
  mockList,
  mockGetPage,
  mockUpdatePage,
  mockDeletePage,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCreateUpload: vi.fn(),
  mockFinalize: vi.fn(),
  mockList: vi.fn(),
  mockGetPage: vi.fn(),
  mockUpdatePage: vi.fn(),
  mockDeletePage: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  };
});
vi.mock('@server/services/publish/publishBundle', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  createBundleUpload: (...a: unknown[]) => mockCreateUpload(...a),
  finalizeBundle: (...a: unknown[]) => mockFinalize(...a),
}));
vi.mock('@server/services/publish/managePublishedPages', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  listPublishedPages: (...a: unknown[]) => mockList(...a),
  getPublishedPage: (...a: unknown[]) => mockGetPage(...a),
  updatePublishedPage: (...a: unknown[]) => mockUpdatePage(...a),
  deletePublishedPage: (...a: unknown[]) => mockDeletePage(...a),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ assertOutboundActionAllowed: vi.fn() }));
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: (_req: any, _res: any, next: any) => next(),
}));

import {
  ListPublishedPagesResponseSchema,
  PublishedPageResourceSchema,
  PublishedPageUploadResourceSchema,
} from '@bike4mind/common';
import { HTTPError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';
import listRoute from '../index';
import uploadRoute from '../uploads/index';
import finalizeRoute from '../uploads/[draft_id]/finalize';
import pageRoute from '../[public_id]/index';

const USER_ID = '65a000000000000000000001';
const DRAFT_ID = '5b1f6a0e-0000-4000-8000-000000000000';
const PUBLIC_ID = 'k3x9d2';

const PAGE_DOC = {
  publicId: PUBLIC_ID,
  ownerId: USER_ID,
  tier: 'user',
  scopeId: USER_ID,
  slug: 'q3-report',
  title: 'Q3 report',
  tags: ['finance'],
  visibility: 'private',
  commentPolicy: 'none',
  discoverable: false,
  embedOrigins: [],
  accessGate: null,
  size: { totalBytes: 20480, fileCount: 3 },
  publishedAt: new Date('2026-10-01T12:00:00.000Z'),
  updatedAt: new Date('2026-10-01T12:00:00.000Z'),
};

const UPLOAD_BODY = {
  tier: 'user',
  scope_id: USER_ID,
  slug: 'q3-report',
  title: 'Q3 report',
  files: [{ path: 'index.html', size: 1024, mime_type: 'text/html' }],
};

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: USER_ID,
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

type FireInit = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; query?: object; body?: object };

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, init: FireInit) {
  const { req, res } = createMocks(
    { ...init, headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' } } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const listPages = (query: object = {}) => fire(listRoute, { method: 'GET', url: '/api/v1/published-pages', query });
const createUpload = (body: object = UPLOAD_BODY) =>
  fire(uploadRoute, { method: 'POST', url: '/api/v1/published-pages/uploads', body });
const finalize = () =>
  fire(finalizeRoute, {
    method: 'POST',
    url: `/api/v1/published-pages/uploads/${DRAFT_ID}/finalize`,
    query: { draft_id: DRAFT_ID },
    body: {},
  });
const pageUrl = `/api/v1/published-pages/${PUBLIC_ID}`;
const getPage = () => fire(pageRoute, { method: 'GET', url: pageUrl, query: { public_id: PUBLIC_ID } });
const patchPage = (body: object = { title: 'Renamed' }) =>
  fire(pageRoute, { method: 'PATCH', url: pageUrl, query: { public_id: PUBLIC_ID }, body });
const deletePage = () => fire(pageRoute, { method: 'DELETE', url: pageUrl, query: { public_id: PUBLIC_ID } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_URL', 'https://app.example.com');
  mockFindUser.mockResolvedValue({ id: USER_ID, _id: USER_ID, groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockList.mockResolvedValue({ items: [PAGE_DOC], total: 1, limit: 25, skip: 0, nextSkip: null });
  mockGetPage.mockResolvedValue({ artifact: PAGE_DOC, isManager: true });
  mockUpdatePage.mockResolvedValue(PAGE_DOC);
  mockDeletePage.mockResolvedValue(undefined);
  mockCreateUpload.mockResolvedValue({
    draftId: DRAFT_ID,
    uploadUrls: [{ path: 'index.html', url: 'https://storage.example.com/x', expiresAt: '2026-10-01T12:10:00.000Z' }],
  });
  mockFinalize.mockResolvedValue({ publicId: PUBLIC_ID });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('published-pages routes', () => {
  beforeEach(() => withScopes([ApiKeyScope.ARTIFACTS_PUBLISH]));

  it('lists only the caller own pages and validates against the contract', async () => {
    const res = await listPages();
    expect(res._getStatusCode()).toBe(200);
    expect(ListPublishedPagesResponseSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(res._getJSONData().next_cursor).toBeNull();
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ mine: true, skip: 0 }));
  });

  it('round-trips the skip offset through an opaque cursor', async () => {
    mockList.mockResolvedValueOnce({ items: [PAGE_DOC], total: 2, limit: 1, skip: 0, nextSkip: 1 });
    const first = await listPages({ limit: '1' });
    const cursor = first._getJSONData().next_cursor;
    expect(typeof cursor).toBe('string');
    await listPages({ limit: '1', cursor });
    expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 1, limit: 1 }));
  });

  it('rejects a cursor from another scope or with a non-integer offset (422)', async () => {
    const { encodeCursor } = await import('@server/utils/cursorPagination');
    expect((await listPages({ cursor: encodeCursor('v1.published-pages', 'abc') }))._getStatusCode()).toBe(422);
    expect((await listPages({ cursor: encodeCursor('v1.artifacts', '5') }))._getStatusCode()).toBe(422);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('creates an upload (201) mapping snake_case to the service input', async () => {
    const res = await createUpload();
    expect(res._getStatusCode()).toBe(201);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(PublishedPageUploadResourceSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockCreateUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: USER_ID,
        files: [{ path: 'index.html', size: 1024, mimeType: 'text/html' }],
      })
    );
  });

  it('re-statuses service errors to declared statuses', async () => {
    mockCreateUpload.mockRejectedValueOnce(new HTTPError(400, 'Too many files', { errorCode: 'too_many_files' }));
    expect((await createUpload())._getStatusCode()).toBe(422);
    mockCreateUpload.mockRejectedValueOnce(new HTTPError(413, 'Quota', { errorCode: 'quota_bytes_exceeded' }));
    expect((await createUpload())._getStatusCode()).toBe(422);
    mockCreateUpload.mockRejectedValueOnce(new HTTPError(403, 'Owned', { errorCode: 'slug_owned_by_other' }));
    expect((await createUpload())._getStatusCode()).toBe(409);
    mockCreateUpload.mockRejectedValueOnce(new HTTPError(403, 'No scope', { errorCode: 'scope_not_permitted' }));
    expect((await createUpload())._getStatusCode()).toBe(422);
    mockFinalize.mockRejectedValueOnce(new HTTPError(403, 'Not yours', { errorCode: 'draft_not_owned' }));
    expect((await finalize())._getStatusCode()).toBe(404);
  });

  it('finalizes (200) and returns the managed page', async () => {
    const res = await finalize();
    expect(res._getStatusCode()).toBe(200);
    expect(PublishedPageResourceSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockFinalize).toHaveBeenCalledWith(expect.objectContaining({ draftId: DRAFT_ID }));
    expect(mockGetPage).toHaveBeenCalledWith(expect.objectContaining({ publicId: PUBLIC_ID }));
  });

  it('gets a managed page (200)', async () => {
    const res = await getPage();
    expect(res._getStatusCode()).toBe(200);
    expect(PublishedPageResourceSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(res._getJSONData().public_id).toBe(PUBLIC_ID);
  });

  it('answers 404 for a page the caller does not manage, including the public-viewer branch', async () => {
    mockGetPage.mockResolvedValueOnce({ artifact: { ...PAGE_DOC, visibility: 'public' }, isManager: false });
    expect((await getPage())._getStatusCode()).toBe(404);
    mockGetPage.mockRejectedValueOnce(new HTTPError(403, 'Not authorized', { errorCode: 'forbidden' }));
    expect((await getPage())._getStatusCode()).toBe(404);
    mockUpdatePage.mockRejectedValueOnce(new HTTPError(403, 'Not authorized', { errorCode: 'forbidden' }));
    expect((await patchPage())._getStatusCode()).toBe(404);
    mockDeletePage.mockRejectedValueOnce(new HTTPError(403, 'Not authorized', { errorCode: 'forbidden' }));
    expect((await deletePage())._getStatusCode()).toBe(404);
  });

  it("answers one identical 404 body for a missing page and another user's private or public page", async () => {
    const bodies: unknown[] = [];
    const strip = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });
    const cases: Array<() => void> = [
      () => mockGetPage.mockRejectedValueOnce(new HTTPError(404, 'Artifact not found', { errorCode: 'not_found' })),
      () =>
        mockGetPage.mockRejectedValueOnce(new HTTPError(403, 'Published page not found', { errorCode: 'forbidden' })),
      () => mockGetPage.mockResolvedValueOnce({ artifact: { ...PAGE_DOC, visibility: 'public' }, isManager: false }),
    ];
    for (const arrange of cases) {
      arrange();
      const res = await getPage();
      expect(res._getStatusCode()).toBe(404);
      bodies.push(strip(res._getJSONData()));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('lets a user who fails the outbound-action check delete and narrow, but not widen', async () => {
    const { assertOutboundActionAllowed } = await import('@server/auth/assertOutboundActionAllowed');
    vi.mocked(assertOutboundActionAllowed).mockRejectedValue(new HTTPError(403, 'Account trust required'));
    expect((await deletePage())._getStatusCode()).toBe(204);
    expect((await patchPage({ visibility: 'private' }))._getStatusCode()).toBe(200);
    expect(assertOutboundActionAllowed).not.toHaveBeenCalled();
    // Widening is refused by the service, which owns that check.
    mockUpdatePage.mockRejectedValueOnce(new HTTPError(403, 'Account trust required'));
    expect((await patchPage({ visibility: 'public' }))._getStatusCode()).toBe(404);
    vi.mocked(assertOutboundActionAllowed).mockReset();
  });

  it('patches (200), mapping the access gate and camelCase fields', async () => {
    const res = await patchPage({
      comment_policy: 'open',
      embed_origins: ['https://example.org'],
      access_gate: { kind: 'domain', allowed_domains: ['example.org'] },
    });
    expect(res._getStatusCode()).toBe(200);
    expect(PublishedPageResourceSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockUpdatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        publicId: PUBLIC_ID,
        patch: expect.objectContaining({
          commentPolicy: 'open',
          embedOrigins: ['https://example.org'],
          accessGate: { kind: 'domain', allowedDomains: ['example.org'] },
        }),
      })
    );
  });

  it('maps a service 400 on patch to 422 and deletes with 204', async () => {
    mockUpdatePage.mockRejectedValueOnce(new HTTPError(400, 'Bad origin', { errorCode: 'embed_origin_invalid' }));
    expect((await patchPage())._getStatusCode()).toBe(422);
    expect((await deletePage())._getStatusCode()).toBe(204);
  });
});
