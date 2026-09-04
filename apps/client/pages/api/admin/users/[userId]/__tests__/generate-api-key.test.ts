import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Scope allowlist guard for the admin key-minting endpoint. The admin endpoint
 * may mint overwatch-ingest:write (admin-provisioned) but not admin:* or
 * cc-bridge:connect - those still have no minting path. All standard user
 * scopes remain mintable here too.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.postHandler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => vi.fn(),
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

const mockUserFind = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'target-user', username: 'targetUser' }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: {},
}));

const mockCreateKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'k1', name: 'key', scopes: ['notebooks:read'] })
);
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { createUserApiKey: (...a: unknown[]) => mockCreateKey(...a) },
}));

const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

import '../generate-api-key';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';

function post(body: unknown, opts: { isAdmin?: boolean; userId?: string } = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: opts.userId ?? 'target-user' },
    body,
  });
  (req as any).user = {
    id: 'caller',
    isAdmin: opts.isAdmin ?? true,
    username: 'admin-user',
  };
  (req as any).ability = {};
  (req as any).ip = '127.0.0.1';
  (req as any).headers = { 'user-agent': 'test' };
  (req as any).logger = { info: vi.fn() };
  return { req, res };
}

describe('POST /api/admin/users/:userId/generate-api-key - scope allowlist guard', () => {
  beforeEach(() => {
    mockCreateKey.mockClear();
    mockUserFind.mockResolvedValue({ id: 'target-user', username: 'targetUser' });
  });

  it('rejects non-admin callers with ForbiddenError before touching the service', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] }, { isAdmin: false });
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects admin:* even from an admin caller with Scope not allowed', async () => {
    const { req, res } = post({ name: 'test', scopes: ['admin:*'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects admin:* even when mixed with valid scopes', async () => {
    const { req, res } = post({ name: 'test', scopes: ['notebooks:read', 'admin:*'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects cc-bridge:connect with Scope not allowed', async () => {
    const { req, res } = post({ name: 'bridge', scopes: ['cc-bridge:connect'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('allows overwatch-ingest:write (admin-provisioned scope) and calls the service', async () => {
    const { req, res } = post({ name: 'ingest', scopes: ['overwatch-ingest:write'] });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ scopes: ['overwatch-ingest:write'] }),
      expect.anything()
    );
  });

  it('allows standard user scopes (notebooks:read) through the admin endpoint', async () => {
    const { req, res } = post({ name: 'plain', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreateKey).toHaveBeenCalled();
  });

  it('records the acting admin, so the key is not readable as a self-service mint', async () => {
    const { req, res } = post({ name: 'plain', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    // The key belongs to the target user, so `userId` is theirs - the acting admin
    // is only recoverable from metadata.
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ metadata: expect.objectContaining({ createdByUserId: 'caller' }) }),
      expect.anything()
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'target-user',
        metadata: expect.objectContaining({ createdByUserId: 'caller', createdByUsername: 'admin-user' }),
      }),
      expect.anything()
    );
  });

  it('rejects with BadRequestError when the target user does not exist', async () => {
    mockUserFind.mockResolvedValueOnce(null);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });
});
