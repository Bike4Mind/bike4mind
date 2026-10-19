// @vitest-environment node
/**
 * Scope enforcement for /api/v1/agents through the REAL baseApi chain (apiKeyAuth included), so the
 * contracts' `scopes` are proven to reach the gate: reads accept agents:read OR agents:write,
 * create/update/delete accept agents:write only, and a rejected key never reaches a repository.
 * Same harness shape as pages/api/v1/projects/__tests__/scopes.integration.test.ts.
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
  mockCount,
  mockFindById,
  mockUpdate,
  mockDelete,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockCount: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => mockFindUser(...a),
      updateMany: vi.fn().mockResolvedValue(undefined),
    }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
    agentRepository: {
      listAccessibleAfterId: (...a: unknown[]) => mockList(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      countByUserId: (...a: unknown[]) => mockCount(...a),
      findById: (...a: unknown[]) => mockFindById(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
      delete: (...a: unknown[]) => mockDelete(...a),
      claimCredits: vi.fn().mockResolvedValue(0),
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
import byId from '../[id]/index';

const AGENT_ID = '65a000000000000000000001';
const AGENT = {
  id: AGENT_ID,
  name: 'Researcher',
  description: 'desc',
  userId: 'user-1',
  triggerWords: ['@help'],
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

const list = () => fire(listOrCreate, { method: 'GET', url: '/api/v1/agents' });
const create = () => fire(listOrCreate, { method: 'POST', url: '/api/v1/agents', body: { name: 'Researcher' } });
const getOne = () => fire(byId, { method: 'GET', url: `/api/v1/agents/${AGENT_ID}`, query: { id: AGENT_ID } });
const patchOne = () =>
  fire(byId, {
    method: 'PATCH',
    url: `/api/v1/agents/${AGENT_ID}`,
    query: { id: AGENT_ID },
    body: { name: 'Renamed' },
  });
const deleteOne = () => fire(byId, { method: 'DELETE', url: `/api/v1/agents/${AGENT_ID}`, query: { id: AGENT_ID } });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isBanned: false,
    disputePending: false,
  });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockList.mockResolvedValue({ data: [AGENT], hasMore: false });
  mockCount.mockResolvedValue(0);
  mockCreate.mockResolvedValue(AGENT);
  mockFindById.mockResolvedValue(AGENT);
  mockUpdate.mockImplementation(async (changes: object) => ({ ...AGENT, ...changes }));
  mockDelete.mockResolvedValue(undefined);
});

describe('/api/v1/agents scope enforcement (real middleware chain)', () => {
  it('a read-only key cannot create an agent (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_AGENTS]);
    const res = await create();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_AGENTS]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a write key can create an agent (201)', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await create();
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toMatchObject({ id: AGENT_ID });
  });

  it('the tier cap is a 400 carrying agent_limit_reached through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockCount.mockResolvedValue(10);
    const res = await create();
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'agent_limit_reached' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([[ApiKeyScope.READ_AGENTS], [ApiKeyScope.WRITE_AGENTS]])('a %s key can list and get', async scope => {
    withScopes([scope]);
    expect((await list())._getStatusCode()).toBe(200);
    expect((await getOne())._getStatusCode()).toBe(200);
  });

  it('a key without an agent scope can neither list nor get (403)', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    expect((await list())._getStatusCode()).toBe(403);
    expect((await getOne())._getStatusCode()).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('an invalid key can neither update nor delete an agent (401) and nothing is written', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const res of [await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(401);
    }
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('a read-only key can neither update nor delete an agent (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_AGENTS]);
    for (const res of [await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_AGENTS]);
    }
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('a write key can update (200) and delete (204) an agent', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const patched = await patchOne();
    expect(patched._getStatusCode()).toBe(200);
    expect(patched._getJSONData()).toMatchObject({ id: AGENT_ID, name: 'Renamed' });
    expect((await deleteOne())._getStatusCode()).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith(AGENT_ID);
  });

  it('an unknown body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fire(byId, {
      method: 'PATCH',
      url: `/api/v1/agents/${AGENT_ID}`,
      query: { id: AGENT_ID },
      body: { users: [] },
    });
    expect(res._getStatusCode()).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
