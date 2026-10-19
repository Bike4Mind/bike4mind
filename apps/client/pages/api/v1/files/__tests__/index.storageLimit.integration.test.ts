// @vitest-environment node
/**
 * The typed 400 body POST /api/v1/files publishes as `createFileUploadResponse400`, driven through the
 * REAL route: the baseApi chain (apiKeyAuth included), the contract handler, createPresignedUpload's size/quota/type gates and the
 * error handler. Only I/O at the edges (S3, the FabFile write, the settings and lake reads) is stubbed,
 * so a refactor that drops the typed fields anywhere on that path fails here.
 * Harness shape follows scopes.integration.test.ts next to this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindUser, mockRateLimit, mockCreateFabFile } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCreateFabFile: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: (...a: unknown[]) => mockCreateFabFile(...a) }));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (req: { user: { id: string } }) => ({
    userId: req.user.id,
    isAdmin: false,
    userTags: [],
    entitlementKeys: [],
    administeredOrgIds: [],
  })),
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

// Settings read stubbed empty, so MaxFileSize falls back to its default; the quota and type gates stay real.
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: vi.fn(async () => ({})),
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
    adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
    scopedSettingsRepository: { findOverrides: vi.fn().mockResolvedValue([]) },
    dataLakeRepository: { findByDatalakeTag: vi.fn().mockResolvedValue(null), find: vi.fn().mockResolvedValue([]) },
    dataLakeBatchRepository: { findById: vi.fn() },
    dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]) },
    organizationRepository: { findById: vi.fn() },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope, StorageLimitErrorSchema, storageLimitToBytes } from '@bike4mind/common';
import { Resource } from 'sst';
import { MAX_FILE_SIZE_DEFAULT_MB } from '@server/utils/maxFileSizeDefault';
import listOrCreate from '../index';

const STORAGE_LIMIT_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_DEFAULT_MB * 1024 * 1024;
const TYPED_FIELDS = ['errorCode', 'used_bytes', 'limit_bytes', 'requested_bytes', 'owner'];

function withUser(currentStorageSize: number) {
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    isBanned: false,
    disputePending: false,
    storageLimit: STORAGE_LIMIT_MB,
    currentStorageSize,
  });
}

async function upload(body: { file_name: string; mime_type: string; file_size: number }) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/v1/files',
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  // any: the handler's Express-typed params vs node-mocks-http mocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (listOrCreate as (req: any, res: any) => Promise<void>)(req, res);
  return res;
}

// vitest.setup.ts mocks sst with the boot secrets only; the presign reads the bucket name per request.
Object.assign(Resource, { fabFileBucket: { name: 'test-bucket' } });

beforeEach(() => {
  vi.clearAllMocks();
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes: [ApiKeyScope.WRITE_FILES],
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockCreateFabFile.mockResolvedValue({ id: '65a000000000000000000001' });
  withUser(0);
});

describe('POST /api/v1/files typed 400 body (real route)', () => {
  it('sanity: an in-quota upload of a supported type is admitted (201)', async () => {
    const res = await upload({ file_name: 'notes.txt', mime_type: 'text/plain', file_size: 10 });
    expect(res._getStatusCode()).toBe(201);
  });

  it('a user over quota gets storage_limit_exceeded with the request numbers', async () => {
    const limit = storageLimitToBytes(STORAGE_LIMIT_MB);
    const used = limit - 100;
    withUser(used);

    const res = await upload({ file_name: 'notes.txt', mime_type: 'text/plain', file_size: 500 });

    expect(res._getStatusCode()).toBe(400);
    const body = res._getJSONData();
    expect(body).toMatchObject({
      errorCode: 'storage_limit_exceeded',
      owner: 'user',
      used_bytes: used,
      limit_bytes: limit,
      requested_bytes: 500,
    });
    expect(StorageLimitErrorSchema.safeParse(body).success).toBe(true);
    expect(mockCreateFabFile).not.toHaveBeenCalled();
  });

  it('a file over the per-file cap gets file_too_large with used_bytes 0', async () => {
    const size = MAX_FILE_SIZE_BYTES + 1;

    const res = await upload({ file_name: 'big.txt', mime_type: 'text/plain', file_size: size });

    expect(res._getStatusCode()).toBe(400);
    const body = res._getJSONData();
    expect(body).toMatchObject({
      errorCode: 'file_too_large',
      owner: 'user',
      used_bytes: 0,
      limit_bytes: MAX_FILE_SIZE_BYTES,
      requested_bytes: size,
    });
    expect(StorageLimitErrorSchema.safeParse(body).success).toBe(true);
    expect(mockCreateFabFile).not.toHaveBeenCalled();
  });

  it('an unsupported file type gets a plain 400 with none of the typed fields', async () => {
    const res = await upload({ file_name: 'setup.exe', mime_type: 'application/x-msdownload', file_size: 10 });

    expect(res._getStatusCode()).toBe(400);
    const body = res._getJSONData();
    for (const field of TYPED_FIELDS) expect(body).not.toHaveProperty(field);
    // The published 400 schema leaves the typed fields optional, so the plain refusal satisfies it too.
    expect(StorageLimitErrorSchema.safeParse(body).success).toBe(true);
    expect(mockCreateFabFile).not.toHaveBeenCalled();
  });
});
