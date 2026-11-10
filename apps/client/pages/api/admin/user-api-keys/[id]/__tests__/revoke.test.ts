import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStatus, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  findKey: vi.fn(),
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
  userApiKeyRepository: { findById: h.findKey, revokeIfNotDisabled: h.revoke },
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

await import('../revoke');

const activeKey = {
  id: 'key-1',
  userId: 'owner-1',
  name: 'CI key',
  keyPrefix: 'b4m_live_abc',
  status: ApiKeyStatus.ACTIVE,
  keyHash: 'SECRET-HASH',
  keyDigest: 'SECRET-DIGEST',
};
const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  query: { id: 'key-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Leaked in a public repo' },
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

describe('POST /api/admin/user-api-keys/[id]/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(activeKey);
    h.revoke.mockResolvedValue(true);
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
  });

  it('is jwt-only and rejects non-admins before any read', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    const req = request({ user: { id: 'u', isAdmin: false } });
    await expect(guarded(req)).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.findKey).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    await expect(h.handler!(request({ body: {} }), response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('404s for a missing key and 409s for one already revoked', async () => {
    h.findKey.mockResolvedValueOnce(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
    h.findKey.mockResolvedValueOnce({ ...activeKey, status: ApiKeyStatus.DISABLED });
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('revokes as the acting admin, ends realtime connections and audits once without secrets', async () => {
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('key-1', 'admin-1', 'Leaked in a public repo');
    expect(h.endConnections).toHaveBeenCalledExactlyOnceWith(
      { apiKeyId: 'key-1' },
      expect.objectContaining({ db: { realtimeConnections: { marker: 'realtime' } } })
    );
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.revoked',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        reason: 'Leaked in a public repo',
        details: { keyId: 'key-1', keyPrefix: 'b4m_live_abc', keyName: 'CI key' },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('SECRET');
    expect(res.json).toHaveBeenCalledWith({ keyId: 'key-1', status: 'disabled' });
  });

  it('409s without an audit row when a concurrent revoke wins the write', async () => {
    h.revoke.mockResolvedValue(false);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.endConnections).not.toHaveBeenCalled();
  });

  it('propagates a failed strict audit write without ending connections', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));
    await expect(h.handler!(request(), response())).rejects.toThrow('audit down');
    expect(h.endConnections).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/user-api-keys/[id]/revoke - delegated admins', () => {
  const delegate = (adminPermissions: string[]) => ({ id: 'admin-1', isAdmin: false, adminPermissions });

  beforeEach(() => {
    vi.clearAllMocks();
    h.audit.mockResolvedValue(undefined);
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(activeKey);
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    h.revoke.mockResolvedValue(true);
  });

  it('refuses a delegate without the permission before any read', async () => {
    await expect(guarded(request({ user: delegate(['support:read']) }))).rejects.toMatchObject({
      statusCode: 403,
      message: 'Missing permission: keys:revoke',
    });
    expect(h.findKey).not.toHaveBeenCalled();
  });

  it('lets a delegate with the permission act on a non-admin owner', async () => {
    await expect(guarded(request({ user: delegate(['keys:revoke']) }))).resolves.not.toThrow();
    expect(h.revoke).toHaveBeenCalled();
  });

  it('refuses a delegate on an admin owner without writing', async () => {
    h.findUser.mockResolvedValue({ id: 'owner-1', isAdmin: false, adminPermissions: ['support:read'] });
    await expect(guarded(request({ user: delegate(['keys:revoke']) }))).rejects.toMatchObject({ statusCode: 403 });
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('lets a full admin act on an admin owner', async () => {
    h.findUser.mockResolvedValue({ id: 'owner-1', isAdmin: true });
    await expect(guarded(request())).resolves.not.toThrow();
    expect(h.revoke).toHaveBeenCalled();
  });
});
