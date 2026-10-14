// @vitest-environment node
/**
 * POST /api/google-drive/estimate-folder walks the caller's Drive, so it must stay off the api-key
 * surface. Drives the real `baseApi` chain (as token.test.ts does) to prove `auth: 'jwtOnly'`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockEstimate, mockGetToken, mockGetSettingsMap } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockEstimate: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetSettingsMap: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

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

vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
}));

vi.mock('@server/integrations/google/drive/common', () => ({
  getValidUserDriveAccessToken: (...a: unknown[]) => mockGetToken(...a),
}));

vi.mock('@server/integrations/google/drive/driveContent', () => ({
  estimateFolder: (...a: unknown[]) => mockEstimate(...a),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, res: any, next: any) => {
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import handler from '../estimate-folder';

const ESTIMATE = {
  fileCount: 3,
  knownBytes: 1234,
  unknownSizeCount: 1,
  overSizeLimitCount: 0,
  unsupportedCount: 1,
  truncated: false,
  overCandidateCap: false,
};

function fire({ apiKey, bearer, body }: { apiKey?: string; bearer?: string; body?: unknown } = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/google-drive/estimate-folder',
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('POST /api/google-drive/estimate-folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue('drive-token');
    mockEstimate.mockResolvedValue(ESTIMATE);
    mockGetSettingsMap.mockResolvedValue({ MaxFileSize: '25' });
  });

  it('rejects an api-key caller without walking Drive', async () => {
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: 'user-1',
      scopes: ['ai:chat'],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    const { req, res } = fire({ apiKey: 'b4m_live_0123456789abcdef0123456789abcdef', body: { folderId: 'F1' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['not a string', { folderId: 42 }],
    ['not a Drive id', { folderId: "x' in parents or '1'='1" }],
  ])('400s when folderId is %s', async (_label, body) => {
    const { req, res } = fire({ bearer: 'live-jwt', body });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it('returns the bounded estimate with the server-resolved MaxFileSize', async () => {
    const before = Date.now();
    const { req, res } = fire({ bearer: 'live-jwt', body: { folderId: 'F1' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      folderId: 'F1',
      ...ESTIMATE,
      maxFileSizeBytes: 25 * 1024 * 1024,
      candidateCap: 20000,
    });
    expect(mockGetToken).toHaveBeenCalledWith('jwt-user');
    const [, folderId, opts] = mockEstimate.mock.calls[0];
    expect(folderId).toBe('F1');
    expect(opts.maxFileSize).toBe(25 * 1024 * 1024);
    expect(opts.maxFolders).toBe(2000);
    expect(opts.deadlineMs - before).toBeGreaterThanOrEqual(20_000);
    expect(opts.deadlineMs - before).toBeLessThan(30_000);
  });
});
