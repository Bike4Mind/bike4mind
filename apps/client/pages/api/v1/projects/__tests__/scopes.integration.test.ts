// @vitest-environment node
/**
 * Scope enforcement for /api/v1/projects through the REAL baseApi chain (apiKeyAuth included), so
 * the contracts' `scopes` are proven to reach the gate: reads accept projects:read OR
 * projects:write, create/update/delete accept projects:write only, and a rejected key never reaches a
 * repository.
 * Same harness shape as pages/api/v1/quests/[id]/__tests__/index.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockList,
  mockCreate,
  mockFindAccessibleById,
  mockFindByIdAndUserId,
  mockUpdate,
} = vi.hoisted(() => ({
  mockFindByIdAndUserId: vi.fn(),
  mockUpdate: vi.fn(),
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockFindAccessibleById: vi.fn(),
}));

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
    projectRepository: {
      listAccessibleAfterId: (...a: unknown[]) => mockList(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      shareable: { findAccessibleById: (...a: unknown[]) => mockFindAccessibleById(...a) },
      findByIdAndUserId: (...a: unknown[]) => mockFindByIdAndUserId(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope } from '@bike4mind/common';
import listOrCreate from '../index';
import getById from '../[id]/index';

const PROJECT_ID = '65a000000000000000000001';
const PROJECT = {
  id: PROJECT_ID,
  name: 'Research',
  description: 'desc',
  sessionIds: [],
  fileIds: [],
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

const list = () => fire(listOrCreate, { method: 'GET', url: '/api/v1/projects' });
const create = () =>
  fire(listOrCreate, { method: 'POST', url: '/api/v1/projects', body: { name: 'Research', description: 'desc' } });
const getOne = () => fire(getById, { method: 'GET', url: `/api/v1/projects/${PROJECT_ID}`, query: { id: PROJECT_ID } });
const patchOne = () =>
  fire(getById, {
    method: 'PATCH',
    url: `/api/v1/projects/${PROJECT_ID}`,
    query: { id: PROJECT_ID },
    body: { name: 'Renamed' },
  });
const deleteOne = () =>
  fire(getById, { method: 'DELETE', url: `/api/v1/projects/${PROJECT_ID}`, query: { id: PROJECT_ID } });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockList.mockResolvedValue({ data: [PROJECT], hasMore: false });
  mockCreate.mockResolvedValue(PROJECT);
  mockFindAccessibleById.mockResolvedValue(PROJECT);
  mockFindByIdAndUserId.mockResolvedValue(PROJECT);
  mockUpdate.mockResolvedValue(undefined);
});

describe('/api/v1/projects scope enforcement (real middleware chain)', () => {
  it('a read-only key cannot create a project (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_PROJECTS]);
    const res = await create();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_PROJECTS]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a write key can create a project (201)', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    const res = await create();
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toMatchObject({ id: PROJECT_ID });
  });

  it.each([[ApiKeyScope.READ_PROJECTS], [ApiKeyScope.WRITE_PROJECTS]])('a %s key can list and get', async scope => {
    withScopes([scope]);
    expect((await list())._getStatusCode()).toBe(200);
    expect((await getOne())._getStatusCode()).toBe(200);
  });

  it('a key without a project scope can neither list nor get (403)', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    expect((await list())._getStatusCode()).toBe(403);
    expect((await getOne())._getStatusCode()).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('a read-only key can neither update nor delete a project (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_PROJECTS]);
    for (const res of [await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_PROJECTS]);
    }
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a write key can update a project (200)', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    const res = await patchOne();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: PROJECT_ID, name: 'Renamed' });
  });

  it('an unknown body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    const res = await fire(getById, {
      method: 'PATCH',
      url: `/api/v1/projects/${PROJECT_ID}`,
      query: { id: PROJECT_ID },
      body: { users: [] },
    });
    expect(res._getStatusCode()).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
