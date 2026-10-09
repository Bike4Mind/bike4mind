// @vitest-environment node
/**
 * Scope enforcement for /api/v1/artifacts through the REAL baseApi chain (apiKeyAuth included), so the
 * contracts' `scopes` are proven to reach the gate: reads accept notebooks:read OR notebooks:write,
 * writes accept notebooks:write only, and a rejected key never reaches the artifact code.
 * Same harness shape as pages/api/v1/files/__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindUser, mockRateLimit, mockList, mockGet, mockCreate, mockUpdate, mockDelete } = vi.hoisted(
  () => ({
    mockValidate: vi.fn(),
    mockFindUser: vi.fn(),
    mockRateLimit: vi.fn(),
    mockList: vi.fn(),
    mockGet: vi.fn(),
    mockCreate: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
  })
);

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/analyticsLog', () => ({
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
    artifactService: {
      get: (...a: unknown[]) => mockGet(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
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
    artifactRepository: { listOwnedBeforeId: (...a: unknown[]) => mockList(...a), findOne: vi.fn() },
    artifactContentRepository: { findLatestContent: vi.fn().mockResolvedValue(null) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope } from '@bike4mind/common';
import listOrCreate from '../index';
import byId from '../[id]/index';

const ARTIFACT_ID = 'mermaid-signup-flow-1';
const ARTIFACT = {
  _id: '65a000000000000000000001',
  id: ARTIFACT_ID,
  type: 'mermaid',
  title: 'Signup flow',
  version: 1,
  status: 'draft',
  tags: [],
  visibility: 'private',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
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

const list = (query: object = {}) => fire(listOrCreate, { method: 'GET', url: '/api/v1/artifacts', query });
const create = (body: object = { type: 'mermaid', title: 'Signup flow', content: 'graph TD; A-->B' }) =>
  fire(listOrCreate, { method: 'POST', url: '/api/v1/artifacts', body });
const getOne = () => fire(byId, { method: 'GET', url: `/api/v1/artifacts/${ARTIFACT_ID}`, query: { id: ARTIFACT_ID } });
const patchOne = (body: object = { title: 'Renamed' }) =>
  fire(byId, { method: 'PATCH', url: `/api/v1/artifacts/${ARTIFACT_ID}`, query: { id: ARTIFACT_ID }, body });
const deleteOne = () =>
  fire(byId, { method: 'DELETE', url: `/api/v1/artifacts/${ARTIFACT_ID}`, query: { id: ARTIFACT_ID } });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockList.mockResolvedValue({ data: [ARTIFACT], hasMore: false });
  mockGet.mockResolvedValue({ artifact: ARTIFACT, content: { content: 'graph TD; A-->B' } });
  mockCreate.mockResolvedValue({ artifact: ARTIFACT });
  mockUpdate.mockResolvedValue({ artifact: ARTIFACT });
  mockDelete.mockResolvedValue({ success: true });
});

describe('/api/v1/artifacts scope enforcement (real middleware chain)', () => {
  it.each([[ApiKeyScope.READ_NOTEBOOKS], [ApiKeyScope.WRITE_NOTEBOOKS]])('a %s key can list and get', async scope => {
    withScopes([scope]);
    expect((await list())._getStatusCode()).toBe(200);
    expect((await getOne())._getStatusCode()).toBe(200);
  });

  it('meters reads against the per-minute limit only, and writes against the daily one too', async () => {
    withScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    await list();
    await getOne();
    await patchOne();
    const meterDaily = mockRateLimit.mock.calls.map(call => call[3].meterDailyLimit);
    expect(meterDaily).toEqual([false, false, true]);
  });

  it('a key without a notebooks scope can neither list nor get (403)', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    expect((await list())._getStatusCode()).toBe(403);
    expect((await getOne())._getStatusCode()).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('a read-only key can neither create, update nor delete (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    for (const res of [await create(), await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_NOTEBOOKS]);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('an invalid key is refused (401) on every method', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const res of [await list(), await create(), await getOne(), await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(401);
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a write key can create (201), update (200) and delete (204)', async () => {
    withScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    expect((await create())._getStatusCode()).toBe(201);
    expect((await patchOne())._getStatusCode()).toBe(200);
    expect((await deleteOne())._getStatusCode()).toBe(204);
  });

  it('an unknown body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_NOTEBOOKS]);
    expect((await patchOne({ visibility: 'public' }))._getStatusCode()).toBe(422);
    expect((await create({ type: 'mermaid', title: 't', content: 'c', sessionId: 's' }))._getStatusCode()).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a bad cursor is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    expect((await list({ cursor: 'not-a-cursor' }))._getStatusCode()).toBe(422);
    expect(mockList).not.toHaveBeenCalled();
  });
});
