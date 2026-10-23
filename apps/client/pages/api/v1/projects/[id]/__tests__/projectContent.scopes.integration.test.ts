// @vitest-environment node
/**
 * Scope enforcement for /api/v1/projects/{id}/(files|sessions) through the REAL baseApi chain
 * (apiKeyAuth included), so the contracts' `scopes` are proven to reach the gate: lists accept
 * projects:read OR projects:write, add/remove accept projects:write only, and a rejected key never
 * reaches a repository or a write helper. The shared write helpers are stubbed; their behavior is
 * covered in projectContent.test.ts.
 * Same harness shape as pages/api/v1/projects/__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockFindAccessibleById,
  mockFilesPage,
  mockSessionsPage,
  mockAddFiles,
  mockRemoveFiles,
  mockAttachSessions,
  mockRemoveSessions,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindAccessibleById: vi.fn(),
  mockFilesPage: vi.fn(),
  mockSessionsPage: vi.fn(),
  mockAddFiles: vi.fn(),
  mockRemoveFiles: vi.fn(),
  mockAttachSessions: vi.fn(),
  mockRemoveSessions: vi.fn(),
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
vi.mock('@server/projects/projectContentMutations', () => ({
  addFilesToProject: (...a: unknown[]) => mockAddFiles(...a),
  removeFilesFromProject: (...a: unknown[]) => mockRemoveFiles(...a),
  removeSessionsFromProject: (...a: unknown[]) => mockRemoveSessions(...a),
}));
vi.mock('@server/projects/attachSessionsToProject', () => ({
  attachSessionsToProject: (...a: unknown[]) => mockAttachSessions(...a),
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
      shareable: { findAccessibleById: (...a: unknown[]) => mockFindAccessibleById(...a) },
    },
    fabFileRepository: { findPageByIds: (...a: unknown[]) => mockFilesPage(...a) },
    sessionRepository: { findPageByIds: (...a: unknown[]) => mockSessionsPage(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope } from '@bike4mind/common';
import filesHandler from '../files/index';
import fileHandler from '../files/[file_id]';
import sessionsHandler from '../sessions/index';
import sessionHandler from '../sessions/[session_id]';

const PROJECT_ID = '65a000000000000000000001';
const ITEM_ID = '65a000000000000000000002';
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

type FireInit = { method: 'GET' | 'POST' | 'DELETE'; url: string; query?: object; body?: object };

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

const base = `/api/v1/projects/${PROJECT_ID}`;
const calls = {
  listFiles: () => fire(filesHandler, { method: 'GET', url: `${base}/files`, query: { id: PROJECT_ID } }),
  addFiles: () =>
    fire(filesHandler, {
      method: 'POST',
      url: `${base}/files`,
      query: { id: PROJECT_ID },
      body: { file_ids: [ITEM_ID] },
    }),
  removeFile: () =>
    fire(fileHandler, {
      method: 'DELETE',
      url: `${base}/files/${ITEM_ID}`,
      query: { id: PROJECT_ID, file_id: ITEM_ID },
    }),
  listSessions: () => fire(sessionsHandler, { method: 'GET', url: `${base}/sessions`, query: { id: PROJECT_ID } }),
  addSessions: () =>
    fire(sessionsHandler, {
      method: 'POST',
      url: `${base}/sessions`,
      query: { id: PROJECT_ID },
      body: { session_ids: [ITEM_ID] },
    }),
  removeSession: () =>
    fire(sessionHandler, {
      method: 'DELETE',
      url: `${base}/sessions/${ITEM_ID}`,
      query: { id: PROJECT_ID, session_id: ITEM_ID },
    }),
};

const READS = [calls.listFiles, calls.listSessions];
const WRITES = [calls.addFiles, calls.removeFile, calls.addSessions, calls.removeSession];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockFindAccessibleById.mockResolvedValue(PROJECT);
  mockFilesPage.mockResolvedValue({ data: [], hasMore: false });
  mockSessionsPage.mockResolvedValue({ data: [], hasMore: false });
  mockAddFiles.mockResolvedValue(PROJECT);
  mockRemoveFiles.mockResolvedValue(PROJECT);
  mockAttachSessions.mockResolvedValue([]);
  mockRemoveSessions.mockResolvedValue(PROJECT);
});

describe('/api/v1/projects/{id}/(files|sessions) scope enforcement (real middleware chain)', () => {
  it.each([[ApiKeyScope.READ_PROJECTS], [ApiKeyScope.WRITE_PROJECTS]])(
    'a %s key can list files and sessions',
    async scope => {
      withScopes([scope]);
      for (const read of READS) expect((await read())._getStatusCode()).toBe(200);
    }
  );

  it('a read-only key cannot add or remove anything (403) and nothing is written', async () => {
    withScopes([ApiKeyScope.READ_PROJECTS]);
    for (const write of WRITES) {
      const res = await write();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_PROJECTS]);
    }
    expect(mockAddFiles).not.toHaveBeenCalled();
    expect(mockRemoveFiles).not.toHaveBeenCalled();
    expect(mockAttachSessions).not.toHaveBeenCalled();
    expect(mockRemoveSessions).not.toHaveBeenCalled();
  });

  it('a write key can add and remove files and sessions', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    expect((await calls.addFiles())._getStatusCode()).toBe(200);
    expect((await calls.removeFile())._getStatusCode()).toBe(204);
    expect((await calls.addSessions())._getStatusCode()).toBe(200);
    expect((await calls.removeSession())._getStatusCode()).toBe(204);
  });

  it('a key without a project scope can do none of it (403)', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    for (const call of [...READS, ...WRITES]) expect((await call())._getStatusCode()).toBe(403);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
    expect(mockFilesPage).not.toHaveBeenCalled();
    expect(mockSessionsPage).not.toHaveBeenCalled();
  });

  it('an invalid key is refused (401) before any handler runs', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const call of [...READS, ...WRITES]) expect((await call())._getStatusCode()).toBe(401);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('an unknown or SPA-spelled body field is a 422 through the real error handler', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    const files = await fire(filesHandler, {
      method: 'POST',
      url: `${base}/files`,
      query: { id: PROJECT_ID },
      body: { fileIds: [ITEM_ID] },
    });
    const sessions = await fire(sessionsHandler, {
      method: 'POST',
      url: `${base}/sessions`,
      query: { id: PROJECT_ID },
      body: { session_ids: [ITEM_ID], extra: true },
    });
    expect(files._getStatusCode()).toBe(422);
    expect(sessions._getStatusCode()).toBe(422);
    expect(mockAddFiles).not.toHaveBeenCalled();
    expect(mockAttachSessions).not.toHaveBeenCalled();
  });
});
