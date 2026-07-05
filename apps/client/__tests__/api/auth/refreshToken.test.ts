import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock baseApi to unwrap the handler function (idiom from rotate-token.test.ts)
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: any) => fn,
  }),
}));

// Real kill-switch comparison so the test exercises the actual enforcement,
// not a stub. (The helper itself is unit-tested in AuthTokenGeneratorService.test.ts.)
vi.mock('@bike4mind/services', () => ({
  isTokenVersionCurrent: (payloadVersion?: number, userVersion?: number) =>
    (payloadVersion ?? 0) === (userVersion ?? 0),
}));

const mockFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...args: any[]) => mockFindById(...args),
  },
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: {
    findByKeyName: vi.fn().mockResolvedValue(null),
  },
}));

// dayjs stub - keeps previousSecret undefined (no recent rotation)
vi.mock('@bike4mind/common', () => ({
  dayjs: () => ({
    isAfter: () => false,
    subtract: () => ({}),
  }),
}));

vi.mock('@server/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnauthorizedError';
    }
  },
}));

const mockVerifyRefreshToken = vi.fn();
const mockCreateAccessToken = vi.fn();
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: {
    verifyRefreshToken: (...args: any[]) => mockVerifyRefreshToken(...args),
    createAccessToken: (...args: any[]) => mockCreateAccessToken(...args),
  },
}));

import handler from '../../../pages/api/auth/refreshToken';

describe('POST /api/auth/refreshToken — tokenVersion kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateAccessToken.mockReturnValue({ accessToken: 'new_access', refreshToken: 'new_refresh' });
  });

  it('rejects a refresh token whose embedded version is stale', async () => {
    // Refresh token carries version 3, but the user has been bumped to 5.
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 3 });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 5 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'stale-token' } });

    await expect(handler(req as any, res as any)).rejects.toThrow('Invalid refresh token');
    expect(mockCreateAccessToken).not.toHaveBeenCalled();
  });

  it('accepts a refresh token whose version matches and mints with the current version', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: 5 });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 5 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'fresh-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateAccessToken).toHaveBeenCalledWith('user-1', 5);
  });

  it('treats a legacy refresh token (no embedded version) as valid against a v0 user', async () => {
    // No tokenVersion in the token (issued before the field existed) normalizes to 0.
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1', tokenVersion: undefined });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 0 });

    const { req, res } = createMocks({ method: 'POST', body: { refresh_token: 'legacy-token' } });

    await handler(req as any, res as any);

    expect(res._getStatusCode()).toBe(200);
    expect(mockCreateAccessToken).toHaveBeenCalledWith('user-1', 0);
  });
});
