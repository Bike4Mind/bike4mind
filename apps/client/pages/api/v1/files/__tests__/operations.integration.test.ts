// @vitest-environment node
/**
 * chunk, search, by-ids and bulk-delete under /api/v1/files, through the REAL baseApi chain
 * (apiKeyAuth included): each route accepts exactly the scope its contract declares, rejects any other
 * key with a 403 before the file code runs, and maps the shared server logic onto the published shape.
 * Same harness shape as scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindUser, mockRateLimit, mockRechunk, mockSearch, mockByIds, mockBulkDelete } = vi.hoisted(
  () => ({
    mockValidate: vi.fn(),
    mockFindUser: vi.fn(),
    mockRateLimit: vi.fn(),
    mockRechunk: vi.fn(),
    mockSearch: vi.fn(),
    mockByIds: vi.fn(),
    mockBulkDelete: vi.fn(),
  })
);

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
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
vi.mock('@server/files/requestFileRechunk', () => ({ requestFileRechunk: (...a: unknown[]) => mockRechunk(...a) }));
vi.mock('@server/files/searchFilesForRequest', () => ({
  searchFilesForRequest: (...a: unknown[]) => mockSearch(...a),
}));
vi.mock('@server/files/listFilesByIds', () => ({ listFilesByIds: (...a: unknown[]) => mockByIds(...a) }));
vi.mock('@server/files/bulkDeleteFilesForUser', () => ({
  bulkDeleteFilesForUser: (...a: unknown[]) => mockBulkDelete(...a),
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
    withTransaction: (fn: () => unknown) => fn(),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope, MAX_FILE_IDS_PER_REQUEST } from '@bike4mind/common';
import chunkHandler from '../[id]/chunk';
import searchHandler from '../search';
import byIdsHandler from '../by-ids';
import bulkDeleteHandler from '../bulk-delete';

const FILE_ID = '65a000000000000000000001';
const OTHER_ID = '65a000000000000000000002';
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

type FireInit = { method: 'GET' | 'POST'; url: string; query?: object; body?: object };

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

const chunk = (body: object = { chunk_size: 512 }, id = FILE_ID) =>
  fire(chunkHandler, { method: 'POST', url: `/api/v1/files/${id}/chunk`, query: { id }, body });
const search = (query: object = {}) => fire(searchHandler, { method: 'GET', url: '/api/v1/files/search', query });
const byIds = (query: object = { ids: FILE_ID }) =>
  fire(byIdsHandler, { method: 'GET', url: '/api/v1/files/by-ids', query });
const bulkDelete = (body: object = { file_ids: [FILE_ID] }) =>
  fire(bulkDeleteHandler, { method: 'POST', url: '/api/v1/files/bulk-delete', body });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockRechunk.mockResolvedValue({ status: 'queued', messageId: 'msg-1' });
  mockSearch.mockResolvedValue({ data: [FILE] });
  mockByIds.mockResolvedValue([FILE]);
  mockBulkDelete.mockResolvedValue({ deleted: [FILE_ID], unshared: [], notFound: [], failed: [] });
});

describe('POST /api/v1/files/{id}/chunk', () => {
  it('a files:write key queues the job (200) with the published shape', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    const res = await chunk();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ message_id: 'msg-1' });
    expect(mockRechunk).toHaveBeenCalledWith(expect.anything(), { fabFileId: FILE_ID, chunkSize: 512 });
  });

  it.each([[ApiKeyScope.READ_FILES], [ApiKeyScope.READ_NOTEBOOKS]])(
    'a %s key is refused (403) and nothing is queued',
    async scope => {
      withScopes([scope]);
      const res = await chunk();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_FILES]);
      expect(mockRechunk).not.toHaveBeenCalled();
    }
  );

  it.each([[{ chunk_size: 63 }], [{ chunk_size: 1501 }], [{ chunk_size: 'big' }], [{}]])(
    'a body of %j is a 422 and nothing is queued',
    async body => {
      withScopes([ApiKeyScope.WRITE_FILES]);
      expect((await chunk(body))._getStatusCode()).toBe(422);
      expect(mockRechunk).not.toHaveBeenCalled();
    }
  );

  it('accepts both ends of the chunk_size range', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    expect((await chunk({ chunk_size: 64 }))._getStatusCode()).toBe(200);
    expect((await chunk({ chunk_size: 1500 }))._getStatusCode()).toBe(200);
  });

  it('a malformed id is a 404 and never reaches the file code', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    expect((await chunk(undefined, 'not-an-id'))._getStatusCode()).toBe(404);
    expect(mockRechunk).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'denied'])('a %s file is a 404, so ids cannot be probed', async status => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    mockRechunk.mockResolvedValue({ status });
    expect((await chunk())._getStatusCode()).toBe(404);
  });

  it('a file already being chunked is a 409', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    mockRechunk.mockResolvedValue({ status: 'already_chunking' });
    expect((await chunk())._getStatusCode()).toBe(409);
  });
});

describe('GET /api/v1/files/search', () => {
  it('a files:read key searches (200) and receives public files, not documents', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    const res = await search({ q: 'ref', type: 'image', limit: '5' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      files: [
        {
          id: FILE_ID,
          file_name: 'reference.png',
          mime_type: 'image/png',
          file_size: 10,
          moderation_status: 'clean',
          download_url: null,
          download_url_expires_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), {
      search: 'ref',
      filters: { type: 'image' },
      pagination: { page: 1, limit: 5 },
    });
  });

  it('omits search and filters the caller did not send', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    await search();
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), { pagination: { page: 1, limit: 25 } });
  });

  it('is exempt from the daily quota', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    expect((await search())._getStatusCode()).toBe(200);
    expect(mockRateLimit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ meterDailyLimit: false })
    );
  });

  it.each([[ApiKeyScope.WRITE_FILES], [ApiKeyScope.READ_NOTEBOOKS]])(
    'a %s key is refused (403) and nothing is searched',
    async scope => {
      withScopes([scope]);
      const res = await search();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.READ_FILES]);
      expect(mockSearch).not.toHaveBeenCalled();
    }
  );

  it.each([[{ limit: '0' }], [{ limit: '101' }], [{ q: '' }], [{ type: 'nonsense' }]])(
    'a query of %j is a 422',
    async query => {
      withScopes([ApiKeyScope.READ_FILES]);
      expect((await search(query))._getStatusCode()).toBe(422);
      expect(mockSearch).not.toHaveBeenCalled();
    }
  );
});

describe('GET /api/v1/files/by-ids', () => {
  it('a files:read key reads several files (200)', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    mockByIds.mockResolvedValue([FILE, { ...FILE, id: OTHER_ID }]);
    const res = await byIds({ ids: `${FILE_ID}, ${OTHER_ID},${FILE_ID}` });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().files.map((f: { id: string }) => f.id)).toEqual([FILE_ID, OTHER_ID]);
    // Trimmed and de-duplicated before it reaches the shared lookup.
    expect(mockByIds).toHaveBeenCalledWith(expect.anything(), [FILE_ID, OTHER_ID]);
  });

  it('drops a malformed id instead of passing it to a query', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    await byIds({ ids: `${FILE_ID},not-an-id` });
    expect(mockByIds).toHaveBeenCalledWith(expect.anything(), [FILE_ID]);
  });

  it('answers a request of only malformed ids without calling the lookup', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    const res = await byIds({ ids: 'nope,also-nope' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ files: [] });
    expect(mockByIds).not.toHaveBeenCalled();
  });

  it.each([[ApiKeyScope.WRITE_FILES], [ApiKeyScope.READ_NOTEBOOKS]])(
    'a %s key is refused (403) and nothing is read',
    async scope => {
      withScopes([scope]);
      const res = await byIds();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.READ_FILES]);
      expect(mockByIds).not.toHaveBeenCalled();
    }
  );

  it('more than the id cap is a 422', async () => {
    withScopes([ApiKeyScope.READ_FILES]);
    const ids = Array.from({ length: MAX_FILE_IDS_PER_REQUEST + 1 }, (_, i) => i.toString(16).padStart(24, '0'));
    expect((await byIds({ ids: ids.join(',') }))._getStatusCode()).toBe(422);
    expect(mockByIds).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ ids: '' }], [{ ids: ' , ' }]])('a query of %j is a 422', async query => {
    withScopes([ApiKeyScope.READ_FILES]);
    expect((await byIds(query))._getStatusCode()).toBe(422);
    expect(mockByIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/files/bulk-delete', () => {
  it('a files:write key deletes (200) and receives the published buckets', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    mockBulkDelete.mockResolvedValue({
      deleted: [FILE_ID],
      unshared: [],
      notFound: [OTHER_ID],
      failed: [{ id: '65a000000000000000000003', error: 'E11000 duplicate key collection: internal' }],
    });
    const res = await bulkDelete({ file_ids: [FILE_ID, OTHER_ID, '65a000000000000000000003'] });
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.deleted).toEqual([FILE_ID]);
    expect(body.not_found).toEqual([OTHER_ID]);
    // The raw failure message can carry internals; only the id is the caller's to act on.
    expect(body.failed).toEqual([{ id: '65a000000000000000000003', error: 'The file could not be processed' }]);
    expect(JSON.stringify(body)).not.toContain('E11000');
  });

  it('reports a malformed id as not_found without deleting it', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    const res = await bulkDelete({ file_ids: [FILE_ID, 'not-an-id'] });
    expect(res._getJSONData().not_found).toEqual(['not-an-id']);
    expect(mockBulkDelete).toHaveBeenCalledWith(expect.anything(), [FILE_ID]);
  });

  it('answers a request of only malformed ids without calling the deleter', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    const res = await bulkDelete({ file_ids: ['nope'] });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ deleted: [], unshared: [], not_found: ['nope'], failed: [] });
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it.each([[ApiKeyScope.READ_FILES], [ApiKeyScope.READ_NOTEBOOKS]])(
    'a %s key is refused (403) and nothing is deleted',
    async scope => {
      withScopes([scope]);
      const res = await bulkDelete();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_FILES]);
      expect(mockBulkDelete).not.toHaveBeenCalled();
    }
  );

  it.each([[{ file_ids: [] }], [{}], [{ file_ids: [''] }]])('a body of %j is a 422', async body => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    expect((await bulkDelete(body))._getStatusCode()).toBe(422);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it('more than the id cap is a 422', async () => {
    withScopes([ApiKeyScope.WRITE_FILES]);
    const file_ids = Array.from({ length: MAX_FILE_IDS_PER_REQUEST + 1 }, (_, i) => i.toString(16).padStart(24, '0'));
    expect((await bulkDelete({ file_ids }))._getStatusCode()).toBe(422);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it('an invalid key is a 401', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    expect((await bulkDelete())._getStatusCode()).toBe(401);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });
});
