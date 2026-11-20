import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStatus, BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  findByUserId: vi.fn(),
  revoke: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
  endConnections: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    h.config = config;
    const chain = {
      use: (guard: unknown) => {
        h.guard ??= guard as typeof h.guard;
        return chain;
      },
      post: (fn: typeof h.handler) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  realtimeConnectionRepository: { marker: 'realtime' },
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: { findByUserId: h.findByUserId, revokeIfNotDisabled: h.revoke },
}));
vi.mock('@bike4mind/services', () => ({ authSessionService: { endRealtimeConnections: h.endConnections } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async () => {
  const { BadRequestError: BadRequest } = await import('@bike4mind/common');
  return {
    parseAdminActionReason: (reason: unknown) => {
      if (typeof reason !== 'string' || !reason) throw new BadRequest('reason required');
      return reason;
    },
    recordAdminActionFromRequest: h.audit,
  };
});

await import('../revoke-api-keys');

const key = (id: string, status: ApiKeyStatus) => ({
  id,
  status,
  keyPrefix: `b4m_live_${id}`,
  keyHash: 'SECRET-HASH',
  keyDigest: 'SECRET-DIGEST',
});
const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  query: { userId: 'owner-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Account compromised' },
  logger: { warn: vi.fn() },
  ...overrides,
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

// Runs the permission guard adminApi installs, then the handler, as the router would.
const guarded = async (req: unknown) => {
  h.guard!(req, {}, () => {});
  return h.handler!(req, response());
};

describe('POST /api/admin/users/[userId]/revoke-api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.revoke.mockResolvedValue(true);
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    h.findByUserId.mockResolvedValue([
      key('a', ApiKeyStatus.ACTIVE),
      key('b', ApiKeyStatus.DISABLED),
      key('c', ApiKeyStatus.RATE_LIMITED),
    ]);
  });

  it('is jwt-only and rejects non-admins, a missing reason and an unknown user', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    await expect(guarded(request({ user: { id: 'u', isAdmin: false } }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.handler!(request({ body: {} }), response())).rejects.toBeInstanceOf(BadRequestError);
    h.findUser.mockResolvedValue(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('revokes every non-disabled key as the acting admin and writes exactly one audit entry', async () => {
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(h.revoke.mock.calls).toEqual([
      ['a', 'admin-1', 'Account compromised'],
      ['c', 'admin-1', 'Account compromised'],
    ]);
    expect(h.endConnections).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_keys.revoked_all',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        reason: 'Account compromised',
        details: {
          count: 2,
          keys: [
            { keyId: 'a', keyPrefix: 'b4m_live_a' },
            { keyId: 'c', keyPrefix: 'b4m_live_c' },
          ],
        },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('SECRET');
    expect(res.json).toHaveBeenCalledWith({ revokedKeyIds: ['a', 'c'] });
  });

  it('audits and returns only the keys this call changed when a concurrent revoke takes some', async () => {
    h.revoke.mockImplementation(async (id: string) => id !== 'a');
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        summary: 'revoked 1 API key',
        details: { count: 1, keys: [{ keyId: 'c', keyPrefix: 'b4m_live_c' }] },
      })
    );
    expect(h.endConnections).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ revokedKeyIds: ['c'] });
  });

  it('writes no audit row when a concurrent revoke takes every key', async () => {
    h.revoke.mockResolvedValue(false);
    const res = response();
    await h.handler!(request(), res);

    expect(h.audit).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ revokedKeyIds: [] });
  });

  it('returns an empty list without an audit write when nothing is left to revoke', async () => {
    h.findByUserId.mockResolvedValue([key('b', ApiKeyStatus.DISABLED)]);
    const res = response();
    await h.handler!(request(), res);

    expect(res.json).toHaveBeenCalledWith({ revokedKeyIds: [] });
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/[userId]/revoke-api-keys - delegated admins', () => {
  const delegate = (adminPermissions: string[]) => ({ id: 'admin-1', isAdmin: false, adminPermissions });

  beforeEach(() => {
    vi.clearAllMocks();
    h.audit.mockResolvedValue(undefined);
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.revoke.mockResolvedValue(true);
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    h.findByUserId.mockResolvedValue([key('a', ApiKeyStatus.ACTIVE)]);
  });

  it('refuses a delegate without keys:revoke before any read', async () => {
    await expect(guarded(request({ user: delegate(['support:read']) }))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.findUser).not.toHaveBeenCalled();
  });

  it('lets a delegate with keys:revoke revoke the keys of a non-admin user', async () => {
    await guarded(request({ user: delegate(['keys:revoke']) }));
    expect(h.revoke).toHaveBeenCalledWith('a', 'admin-1', 'Account compromised');
  });

  it('refuses a delegate on an admin user without revoking', async () => {
    h.findUser.mockResolvedValue({ id: 'owner-1', isAdmin: true });
    await expect(guarded(request({ user: delegate(['keys:revoke']) }))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
