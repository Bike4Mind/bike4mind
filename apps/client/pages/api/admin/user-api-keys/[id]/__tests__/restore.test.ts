import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_API_KEY_RESTORE_WINDOW_MINUTES,
  ApiKeyStatus,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  findKey: vi.fn(),
  restore: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    return {
      use: () => ({
        post: (fn: typeof h.handler) => {
          h.handler = fn;
          return {};
        },
      }),
    };
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  realtimeConnectionRepository: {},
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: { findById: h.findKey, restoreRevoked: h.restore },
}));
vi.mock('@bike4mind/services', () => ({
  authSessionService: { endRealtimeConnections: vi.fn() },
  // A stand-in for the real predicate: one flag per block reason is all these cases need.
  userService: {
    accountBlockReasons: (user: { isBanned?: boolean; disputePending?: boolean }) => [
      ...(user.isBanned ? ['banned'] : []),
      ...(user.disputePending ? ['disputePending'] : []),
    ],
  },
}));
vi.mock('@server/utils/adminAudit', async () => {
  const { BadRequestError: BadRequest } = await import('@bike4mind/common');
  return {
    parseAdminActionReason: (reason: unknown) => {
      if (typeof reason !== 'string' || !reason) throw new BadRequest('reason required');
      return reason;
    },
    recordAdminActionFromRequest: h.audit,
  };
});

await import('../restore');

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const revokedKey = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-1',
  userId: 'owner-1',
  name: 'CI key',
  keyPrefix: 'b4m_live_abc',
  status: ApiKeyStatus.DISABLED,
  revokedBy: 'admin-1',
  revokedAt: minutesAgo(1),
  keyHash: 'SECRET-HASH',
  ...overrides,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  query: { id: 'key-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Revoked by mistake' },
  ...overrides,
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/admin/user-api-keys/[id]/restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(revokedKey());
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    h.restore.mockResolvedValue(true);
  });

  it('is jwt-only and rejects non-admins and a missing reason before any read', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
    await expect(h.handler!(request({ user: { id: 'u', isAdmin: false } }), response())).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(h.handler!(request({ body: {} }), response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findKey).not.toHaveBeenCalled();
  });

  it('404s for a missing key', async () => {
    h.findKey.mockResolvedValue(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['the key is not revoked', { status: ApiKeyStatus.ACTIVE }],
    ['another admin revoked it', { revokedBy: 'admin-2' }],
    ['the revoke predates the window', { revokedAt: minutesAgo(ADMIN_API_KEY_RESTORE_WINDOW_MINUTES + 1) }],
    ['the revoke has no timestamp', { revokedAt: undefined }],
    ['the key has expired', { expiresAt: minutesAgo(1) }],
  ])('409s when %s', async (_name, overrides) => {
    h.findKey.mockResolvedValue(revokedKey(overrides));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['banned', { isBanned: true }],
    ['under a payment dispute', { disputePending: true }],
  ])('409s when the owner is %s, so lifting the block later cannot revive the key', async (_name, block) => {
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com', ...block });
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('409s without auditing when a concurrent restore wins the conditional write', async () => {
    h.restore.mockResolvedValue(false);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('restores atomically with the window enforced in the write and audits once without secrets', async () => {
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(h.restore).toHaveBeenCalledExactlyOnceWith('key-1', 'admin-1', expect.any(Date));
    const since = h.restore.mock.calls[0][2] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(ADMIN_API_KEY_RESTORE_WINDOW_MINUTES * 60_000 - 1000);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.restored',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        reason: 'Revoked by mistake',
        details: { keyId: 'key-1', keyPrefix: 'b4m_live_abc', keyName: 'CI key' },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('SECRET');
    expect(res.json).toHaveBeenCalledWith({ keyId: 'key-1', status: 'active' });
  });
});
