// @vitest-environment node
/**
 * Scope enforcement for /api/v1/published-pages through the REAL baseApi chain (apiKeyAuth included):
 * every operation needs artifacts:publish, a rejected key never reaches a service, and a bad body is a 422.
 * Same harness shape as pages/api/v1/artifacts/__tests__/scopes.integration.test.ts.
 *
 * To cover another operation, add one row to OPERATIONS: `call` fires it, `service` is the mock that must
 * stay untouched on a 403, `okStatus` is the status a scoped key gets, `badBody` (optional) is a body
 * that must be a 422.
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
  mockRestore,
  mockListLinks,
  mockCreateLink,
  mockRevokeLink,
  mockListComments,
  mockCreateComment,
  mockUpdateComment,
  mockDeleteComment,
  mockDownload,
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
  mockRestore: vi.fn(),
  mockListLinks: vi.fn(),
  mockCreateLink: vi.fn(),
  mockRevokeLink: vi.fn(),
  mockListComments: vi.fn(),
  mockCreateComment: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
  mockDownload: vi.fn(),
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
vi.mock('@server/services/publish/restorePublishedVersion', () => ({
  restorePublishedVersion: (...a: unknown[]) => mockRestore(...a),
}));
vi.mock('@server/services/publish/shareLinks', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  listShareLinks: (...a: unknown[]) => mockListLinks(...a),
  createShareLink: (...a: unknown[]) => mockCreateLink(...a),
  revokeShareLink: (...a: unknown[]) => mockRevokeLink(...a),
}));
vi.mock('@server/services/publish/annotations', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  listAnnotations: (...a: unknown[]) => mockListComments(...a),
  createAnnotation: (...a: unknown[]) => mockCreateComment(...a),
  updateAnnotation: (...a: unknown[]) => mockUpdateComment(...a),
  deleteAnnotation: (...a: unknown[]) => mockDeleteComment(...a),
}));
vi.mock('@server/services/publish/resolveBundleDownload', () => ({
  resolveBundleDownload: (...a: unknown[]) => mockDownload(...a),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getPublishedArtifactsStorage: () => ({}) }));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ assertOutboundActionAllowed: vi.fn() }));
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: (_req: any, _res: any, next: any) => next(),
}));

import type { Mock } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import listRoute from '../index';
import uploadRoute from '../uploads/index';
import finalizeRoute from '../uploads/[draft_id]/finalize';
import pageRoute from '../[public_id]/index';
import restoreRoute from '../[public_id]/restore';
import linksRoute from '../[public_id]/share-links/index';
import linkRoute from '../[public_id]/share-links/[link_id]';
import commentsRoute from '../[public_id]/comments/index';
import commentRoute from '../[public_id]/comments/[comment_id]';
import downloadRoute from '../[public_id]/files/download';

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

const LINK_ID = '5b1f6a0e00000000000000b1';
const COMMENT_ID = 'c1';
const COMMENT_DTO = {
  id: COMMENT_ID,
  publicId: PUBLIC_ID,
  kind: 'comment',
  authorDisplayName: 'Ada',
  body: 'Looks right.',
  threadRootId: null,
  resolvedAt: null,
  createdAt: '2026-10-02T09:30:00.000Z',
};
const LINK_VIEW = {
  id: LINK_ID,
  shareToken: 'tok-abcd',
  shareUrl: '/a/tok-abcd',
  createdAt: new Date('2026-10-01T12:00:00.000Z'),
  expiresAt: null,
  viewCount: 0,
  lastViewedAt: null,
};
const restorePage = (body: object = {}) =>
  fire(restoreRoute, { method: 'POST', url: `${pageUrl}/restore`, query: { public_id: PUBLIC_ID }, body });
const listLinks = () =>
  fire(linksRoute, { method: 'GET', url: `${pageUrl}/share-links`, query: { public_id: PUBLIC_ID } });
const createLink = (body: object = {}) =>
  fire(linksRoute, { method: 'POST', url: `${pageUrl}/share-links`, query: { public_id: PUBLIC_ID }, body });
const revokeLink = () =>
  fire(linkRoute, {
    method: 'DELETE',
    url: `${pageUrl}/share-links/${LINK_ID}`,
    query: { public_id: PUBLIC_ID, link_id: LINK_ID },
  });
const listComments = () =>
  fire(commentsRoute, { method: 'GET', url: `${pageUrl}/comments`, query: { public_id: PUBLIC_ID } });
const createComment = (body: object = { body: 'Looks right.' }) =>
  fire(commentsRoute, { method: 'POST', url: `${pageUrl}/comments`, query: { public_id: PUBLIC_ID }, body });
const updateComment = (body: object = { resolved: true }) =>
  fire(commentRoute, {
    method: 'PATCH',
    url: `${pageUrl}/comments/${COMMENT_ID}`,
    query: { public_id: PUBLIC_ID, comment_id: COMMENT_ID },
    body,
  });
const deleteComment = () =>
  fire(commentRoute, {
    method: 'DELETE',
    url: `${pageUrl}/comments/${COMMENT_ID}`,
    query: { public_id: PUBLIC_ID, comment_id: COMMENT_ID },
  });
const download = () =>
  fire(downloadRoute, {
    method: 'GET',
    url: `${pageUrl}/files/download`,
    query: { public_id: PUBLIC_ID, path: 'index.html' },
  });

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
  mockRestore.mockResolvedValue({});
  mockListLinks.mockResolvedValue([LINK_VIEW]);
  mockCreateLink.mockResolvedValue({ ...LINK_VIEW, shareLinks: [LINK_VIEW] });
  mockRevokeLink.mockResolvedValue({ revoked: true, remaining: 0 });
  mockListComments.mockResolvedValue({ annotations: [COMMENT_DTO] });
  mockCreateComment.mockResolvedValue(COMMENT_DTO);
  mockUpdateComment.mockResolvedValue(COMMENT_DTO);
  mockDeleteComment.mockResolvedValue(undefined);
  mockDownload.mockResolvedValue({ key: 'k', disposition: 'attachment', url: 'https://storage.example.com/signed' });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Operation = {
  name: string;
  call: (body?: object) => ReturnType<typeof fire>;
  service: Mock;
  okStatus: number;
  badBody?: object;
};

const OPERATIONS: Operation[] = [
  { name: 'listPublishedPages', call: () => listPages(), service: mockList, okStatus: 200 },
  {
    name: 'createPublishedPageUpload',
    call: body => createUpload(body),
    service: mockCreateUpload,
    okStatus: 201,
    badBody: { ...UPLOAD_BODY, files: [] },
  },
  { name: 'finalizePublishedPage', call: () => finalize(), service: mockFinalize, okStatus: 200 },
  { name: 'getPublishedPage', call: () => getPage(), service: mockGetPage, okStatus: 200 },
  {
    name: 'updatePublishedPage',
    call: body => patchPage(body),
    service: mockUpdatePage,
    okStatus: 200,
    badBody: { unknown_field: true },
  },
  { name: 'deletePublishedPage', call: () => deletePage(), service: mockDeletePage, okStatus: 204 },
  {
    name: 'restorePublishedPageVersion',
    call: body => restorePage(body),
    service: mockRestore,
    okStatus: 200,
    badBody: { unknown_field: true },
  },
  { name: 'listPublishedPageShareLinks', call: () => listLinks(), service: mockListLinks, okStatus: 200 },
  {
    name: 'createPublishedPageShareLink',
    call: body => createLink(body),
    service: mockCreateLink,
    okStatus: 201,
    badBody: { expires_at: 'tomorrow' },
  },
  { name: 'revokePublishedPageShareLink', call: () => revokeLink(), service: mockRevokeLink, okStatus: 204 },
  { name: 'listPublishedPageComments', call: () => listComments(), service: mockListComments, okStatus: 200 },
  {
    name: 'createPublishedPageComment',
    call: body => createComment(body),
    service: mockCreateComment,
    okStatus: 201,
    badBody: { body: '' },
  },
  {
    name: 'updatePublishedPageComment',
    call: body => updateComment(body),
    service: mockUpdateComment,
    okStatus: 200,
    badBody: {},
  },
  { name: 'deletePublishedPageComment', call: () => deleteComment(), service: mockDeleteComment, okStatus: 204 },
  { name: 'downloadPublishedPageFile', call: () => download(), service: mockDownload, okStatus: 303 },
];

describe('/api/v1/published-pages scope enforcement (real middleware chain)', () => {
  it.each([[ApiKeyScope.READ_NOTEBOOKS], [ApiKeyScope.WRITE_NOTEBOOKS], [ApiKeyScope.WRITE_FILES]])(
    'a %s key is refused (403) on every operation and no service runs',
    async scope => {
      withScopes([scope]);
      for (const op of OPERATIONS) {
        const res = await op.call();
        expect(res._getStatusCode(), op.name).toBe(403);
        expect(res._getJSONData().required_scopes, op.name).toEqual([ApiKeyScope.ARTIFACTS_PUBLISH]);
        expect(op.service, op.name).not.toHaveBeenCalled();
      }
    }
  );

  it('an artifacts:publish key passes every operation', async () => {
    withScopes([ApiKeyScope.ARTIFACTS_PUBLISH]);
    for (const op of OPERATIONS) {
      vi.clearAllMocks();
      expect((await op.call())._getStatusCode(), op.name).toBe(op.okStatus);
      expect(op.service, op.name).toHaveBeenCalledTimes(1);
    }
  });

  it('each operation row names its own service, not the shared page lookup', () => {
    for (const op of OPERATIONS) {
      if (op.name !== 'getPublishedPage') expect(op.service, op.name).not.toBe(mockGetPage);
    }
  });

  it('an invalid key is refused (401) on every operation', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const op of OPERATIONS) {
      expect((await op.call())._getStatusCode(), op.name).toBe(401);
      expect(op.service, op.name).not.toHaveBeenCalled();
    }
  });

  it('a bad body is a 422 and no service runs', async () => {
    withScopes([ApiKeyScope.ARTIFACTS_PUBLISH]);
    for (const op of OPERATIONS.filter(o => o.badBody)) {
      expect((await op.call(op.badBody))._getStatusCode(), op.name).toBe(422);
      expect(op.service, op.name).not.toHaveBeenCalled();
    }
  });

  it('a bad cursor is a 422', async () => {
    withScopes([ApiKeyScope.ARTIFACTS_PUBLISH]);
    expect((await listPages({ cursor: 'not-a-cursor' }))._getStatusCode()).toBe(422);
    expect(mockList).not.toHaveBeenCalled();
  });
});

it('covers every published-pages operation in the contract', async () => {
  const contracts = await import('@bike4mind/common');
  const ids = Object.values(contracts)
    .filter(
      (c): c is { operationId: string; path: string } =>
        typeof c === 'object' &&
        c !== null &&
        'path' in c &&
        String((c as { path: unknown }).path).startsWith('/api/v1/published-pages')
    )
    .map(c => c.operationId)
    .sort();
  expect(OPERATIONS.map(o => o.name).sort()).toEqual(ids);
});
