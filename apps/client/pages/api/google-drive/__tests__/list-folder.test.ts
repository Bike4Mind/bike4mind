// @vitest-environment node
/**
 * POST /api/google-drive/list-folder: a token Drive rejects must come back as a reconnect 400, never
 * a bare 401 (which ApiContext reads as the app session expiring). Drives the real `baseApi` chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockList, mockGetToken } = vi.hoisted(() => ({ mockList: vi.fn(), mockGetToken: vi.fn() }));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/integrations/google/drive/common', () => ({
  getValidUserDriveAccessToken: (...a: unknown[]) => mockGetToken(...a),
}));
vi.mock('@bike4mind/server-utils/integrations/google/drive/driveClient', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  listFolderChildren: (...a: unknown[]) => mockList(...a),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (req: any, _res: any, next: any) => {
    req.user = JWT_USER;
    next();
  },
}));

import handler from '../list-folder';

function fire() {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/google-drive/list-folder',
      headers: { authorization: 'Bearer live-jwt' },
      body: { folderId: 'F1' },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('POST /api/google-drive/list-folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue('drive-token');
  });

  it('lists the folder children', async () => {
    mockList.mockResolvedValue([{ id: 'a', name: 'a.txt', mimeType: 'text/plain' }]);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ folderId: 'F1', count: 1 });
  });

  it('maps a Drive 401 to a reconnect 400, never a 401', async () => {
    mockList.mockRejectedValue(Object.assign(new Error('Invalid Credentials'), { status: 401 }));
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.stringify(res._getJSONData())).toContain('reconnect required');
  });
});
