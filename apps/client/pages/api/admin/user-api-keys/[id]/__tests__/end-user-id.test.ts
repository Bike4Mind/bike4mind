import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  ApiKeyStatus,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: null as unknown,
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  findKey: vi.fn(),
  setScopeHeld: vi.fn(),
  findUser: vi.fn(),
  audit: vi.fn(),
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
  realtimeConnectionRepository: {},
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: { findById: h.findKey, setScopeHeld: h.setScopeHeld },
}));
vi.mock('@bike4mind/services', () => ({ authSessionService: { endRealtimeConnections: vi.fn() } }));
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

await import('../end-user-id');

const activeKey = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-1',
  userId: 'owner-1',
  name: 'Platform key',
  keyPrefix: 'b4m_live_abc',
  status: ApiKeyStatus.ACTIVE,
  scopes: [ApiKeyScope.AI_CHAT],
  keyHash: 'SECRET-HASH',
  ...overrides,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  query: { id: 'key-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { enabled: true, reason: 'Serves a product with many end users' },
  ...overrides,
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/admin/user-api-keys/[id]/end-user-id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(activeKey());
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
  });

  it('is jwt-only and refuses a delegate even with keys:revoke, before any read', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    const delegate = { id: 'admin-2', isAdmin: false, adminPermissions: ['keys:revoke'] };
    const req = request({ user: delegate });
    h.guard!(req, {}, () => {});
    await expect(h.handler!(req, response())).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.findKey).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing reason', { enabled: true }],
    ['a non-boolean enabled', { enabled: 'yes', reason: 'r' }],
  ])('400s on %s', async (_name, body) => {
    await expect(h.handler!(request({ body }), response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.setScopeHeld).not.toHaveBeenCalled();
  });

  it('404s for a missing key', async () => {
    h.findKey.mockResolvedValue(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['the key is revoked', { status: ApiKeyStatus.DISABLED }],
    ['the key is confined', { scopes: [ApiKeyScope.EMBED_CHAT] }],
  ])('409s when %s', async (_name, overrides) => {
    h.findKey.mockResolvedValue(activeKey(overrides));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.setScopeHeld).not.toHaveBeenCalled();
  });

  it('409s when enabling on a key with neither ai:chat nor ai:generate', async () => {
    h.findKey.mockResolvedValue(activeKey({ scopes: [ApiKeyScope.ADMIN] }));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.setScopeHeld).not.toHaveBeenCalled();
  });

  it('allows enabling on an ai:generate-only key', async () => {
    h.findKey.mockResolvedValue(activeKey({ scopes: [ApiKeyScope.AI_GENERATE] }));
    await h.handler!(request(), response());
    expect(h.setScopeHeld).toHaveBeenCalledExactlyOnceWith('key-1', ApiKeyScope.AI_END_USER_ID, true);
  });

  it('always allows disabling, even without an ai scope', async () => {
    h.findKey.mockResolvedValue(activeKey({ scopes: [ApiKeyScope.AI_END_USER_ID] }));
    await h.handler!(request({ body: { enabled: false, reason: 'r' } }), response());
    expect(h.setScopeHeld).toHaveBeenCalledExactlyOnceWith('key-1', ApiKeyScope.AI_END_USER_ID, false);
  });

  it.each([true, false])('sets the scope held=%s and audits it without secrets', async enabled => {
    const req = request({ body: { enabled, reason: 'Serves a product with many end users' } });
    const res = response();
    await h.handler!(req, res);

    expect(h.setScopeHeld).toHaveBeenCalledExactlyOnceWith('key-1', ApiKeyScope.AI_END_USER_ID, enabled);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.end_user_id_updated',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        details: { keyId: 'key-1', keyPrefix: 'b4m_live_abc', keyName: 'Platform key', enabled },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('SECRET');
    expect(res.json).toHaveBeenCalledWith({ keyId: 'key-1', endUserIdEnabled: enabled });
  });
});
