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
  findKey: vi.fn(),
  findUser: vi.fn(),
  rotate: vi.fn(),
  audit: vi.fn(),
  withTransaction: vi.fn(),
  endRealtime: vi.fn(),
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
  organizationRepository: { marker: 'orgs' },
  realtimeConnectionRepository: { marker: 'realtime' },
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById: h.findKey, marker: 'keys' } }));
vi.mock('@bike4mind/services', () => ({
  authSessionService: { endRealtimeConnections: h.endRealtime },
  userApiKeyService: { rotateUserApiKey: h.rotate },
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

await import('../rotate');

const NEW_SECRET = 'b4m_live_NEWSECRETVALUE0123456789abcdef';
const activeKey = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-1',
  userId: 'owner-1',
  name: 'CI key',
  keyPrefix: 'b4m_live_old',
  status: ApiKeyStatus.ACTIVE,
  ...overrides,
});
const request = (overrides: Record<string, unknown> = {}) => ({
  query: { id: 'key-1' },
  user: { id: 'admin-1', isAdmin: true },
  body: { reason: 'Rotating after a laptop theft' },
  ...overrides,
});
const response = () => {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('POST /api/admin/user-api-keys/[id]/rotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    h.findKey.mockResolvedValue(activeKey());
    h.findUser.mockResolvedValue({ id: 'owner-1', email: 'owner@example.com' });
    h.rotate.mockResolvedValue({ id: 'key-1', name: 'CI key', keyPrefix: 'b4m_live_new', key: NEW_SECRET });
  });

  it('is jwt-only and rejects non-admins and a missing reason before any read', async () => {
    expect(h.config).toEqual({ auth: 'jwtOnly' });
    await expect(h.handler!(request({ user: { id: 'u', isAdmin: false } }), response())).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(h.handler!(request({ body: {} }), response())).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findKey).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('404s for a missing key', async () => {
    h.findKey.mockResolvedValue(null);
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['revoked', { status: ApiKeyStatus.DISABLED }],
    ['rate limited', { status: ApiKeyStatus.RATE_LIMITED }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('409s for a %s key', async (_name, overrides) => {
    h.findKey.mockResolvedValue(activeKey(overrides));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([ApiKeyScope.ADMIN, ApiKeyScope.CC_BRIDGE])('refuses a key holding the %s scope', async scope => {
    h.findKey.mockResolvedValue(activeKey({ scopes: [ApiKeyScope.AI_CHAT, scope] }));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('re-checks the key inside the transaction and refuses one revoked since the first read', async () => {
    h.findKey.mockResolvedValueOnce(activeKey()).mockResolvedValueOnce(activeKey({ status: ApiKeyStatus.DISABLED }));
    await expect(h.handler!(request(), response())).rejects.toBeInstanceOf(ConflictError);
    expect(h.findKey).toHaveBeenCalledTimes(2);
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('rotates as the key owner so the key is not re-owned to the admin', async () => {
    await h.handler!(request(), response());

    expect(h.rotate).toHaveBeenCalledExactlyOnceWith(
      'owner-1',
      { keyId: 'key-1' },
      {
        db: {
          userApiKeys: expect.objectContaining({ marker: 'keys' }),
          organizations: { marker: 'orgs' },
        },
      }
    );
  });

  it('returns the new secret once, uncached, while the audit row has prefixes but no secret', async () => {
    const req = request();
    const res = response();
    await h.handler!(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({ keyId: 'key-1', keyPrefix: 'b4m_live_new', secret: NEW_SECRET });
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(
      req,
      expect.objectContaining({
        action: 'user.api_key.rotated',
        target: { kind: 'user', id: 'owner-1', displayName: 'owner@example.com' },
        reason: 'Rotating after a laptop theft',
        details: { keyId: 'key-1', keyName: 'CI key', previousKeyPrefix: 'b4m_live_old', keyPrefix: 'b4m_live_new' },
      })
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('NEWSECRET');
  });

  it('never returns a secret when the strict audit write fails', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    const res = response();
    await expect(h.handler!(request(), res)).rejects.toThrow('audit down');
    expect(res.json).not.toHaveBeenCalled();
    expect(h.endRealtime).not.toHaveBeenCalled();
  });

  it('ends the old secret sockets only after the rotation commits', async () => {
    h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => {
      const result = await fn();
      expect(h.endRealtime).not.toHaveBeenCalled();
      return result;
    });
    await h.handler!(request(), response());
    expect(h.endRealtime).toHaveBeenCalledExactlyOnceWith(
      { apiKeyId: 'key-1' },
      expect.objectContaining({ db: { realtimeConnections: { marker: 'realtime' } } })
    );
  });
});
