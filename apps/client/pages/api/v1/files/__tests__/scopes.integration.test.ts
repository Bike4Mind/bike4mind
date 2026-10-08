// @vitest-environment node
/**
 * Scope enforcement for /api/v1/files through the REAL baseApi chain (apiKeyAuth included), so the
 * contracts' `scopes` are proven to reach the gate: list/get accept files:read OR files:write,
 * upload/update/delete accept files:write only, and a rejected key never reaches the file code.
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
  mockLoad,
  mockCreateUpload,
  mockUpdateFabFile,
  mockDeleteFileForUser,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockList: vi.fn(),
  mockLoad: vi.fn(),
  mockCreateUpload: vi.fn(),
  mockUpdateFabFile: vi.fn(),
  mockDeleteFileForUser: vi.fn(),
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
vi.mock('@server/files/loadAccessibleFabFile', () => ({ loadAccessibleFabFile: (...a: unknown[]) => mockLoad(...a) }));
vi.mock('@server/files/deleteFileForUser', () => ({
  deleteFileForUser: (...a: unknown[]) => mockDeleteFileForUser(...a),
}));
vi.mock('@server/files/createPresignedUpload', () => ({
  createPresignedUpload: (...a: unknown[]) => mockCreateUpload(...a),
  PRESIGNED_UPLOAD_EXPIRES_IN: 600,
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: async () => ({ administeredOrgIds: [] }) }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    fabFilesService: {
      ...(actual.fabFilesService as object),
      updateFabFile: (...a: unknown[]) => mockUpdateFabFile(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    withTransaction: (fn: () => unknown) => fn(),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
    fabFileRepository: { listOwnedAfterId: (...a: unknown[]) => mockList(...a) },
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

const FILE_ID = '65a000000000000000000001';
const FILE = {
  id: FILE_ID,
  fileName: 'reference.png',
  mimeType: 'image/png',
  fileSize: 10,
  moderationStatus: 'clean',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
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

const list = (query: object = {}) => fire(listOrCreate, { method: 'GET', url: '/api/v1/files', query });
const upload = () =>
  fire(listOrCreate, {
    method: 'POST',
    url: '/api/v1/files',
    body: { file_name: 'reference.png', mime_type: 'image/png', file_size: 10 },
  });
const getOne = () => fire(byId, { method: 'GET', url: `/api/v1/files/${FILE_ID}`, query: { id: FILE_ID } });
const patchOne = (body: object = { file_name: 'renamed.png' }) =>
  fire(byId, { method: 'PATCH', url: `/api/v1/files/${FILE_ID}`, query: { id: FILE_ID }, body });
const deleteOne = () => fire(byId, { method: 'DELETE', url: `/api/v1/files/${FILE_ID}`, query: { id: FILE_ID } });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockList.mockResolvedValue({ data: [FILE], hasMore: false });
  mockLoad.mockResolvedValue(FILE);
  mockCreateUpload.mockResolvedValue({ url: 'https://bucket.example/key', fileId: FILE_ID });
  mockUpdateFabFile.mockResolvedValue(FILE);
  mockDeleteFileForUser.mockResolvedValue('deleted');
});

describe('/api/v1/files scope enforcement (real middleware chain)', () => {
  it.each([[ApiKeyScope.READ_FILES], [ApiKeyScope.WRITE_FILES]])('a %s key can list and get', async scope => {
    withScopes([scope]);
    expect((await list())._getStatusCode()).toBe(200);
    expect((await getOne())._getStatusCode()).toBe(200);
  });

  it('a key without a files scope can neither list nor get (403)', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    expect((await list())._getStatusCode()).toBe(403);
    expect((await getOne())._getStatusCode()).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('a read-only key can neither upload, update nor delete (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    for (const res of [await upload(), await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_FILES]);
    }
    expect(mockCreateUpload).not.toHaveBeenCalled();
    expect(mockUpdateFabFile).not.toHaveBeenCalled();
    expect(mockDeleteFileForUser).not.toHaveBeenCalled();
  });

  it('an invalid key can neither update nor delete (401)', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const res of [await patchOne(), await deleteOne()]) {
      expect(res._getStatusCode()).toBe(401);
    }
    expect(mockUpdateFabFile).not.toHaveBeenCalled();
    expect(mockDeleteFileForUser).not.toHaveBeenCalled();
  });

  it('a write key can upload (201), update (200) and delete (204)', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    expect((await upload())._getStatusCode()).toBe(201);
    const patched = await patchOne();
    expect(patched._getStatusCode()).toBe(200);
    expect(patched._getJSONData()).toMatchObject({ id: FILE_ID });
    expect((await deleteOne())._getStatusCode()).toBe(204);
  });

  it('an unknown PATCH body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    const res = await patchOne({ tags: [] });
    expect(res._getStatusCode()).toBe(422);
    expect(mockUpdateFabFile).not.toHaveBeenCalled();
  });

  it('an empty search is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    const res = await list({ search: '' });
    expect(res._getStatusCode()).toBe(422);
    expect(mockList).not.toHaveBeenCalled();
  });
});
