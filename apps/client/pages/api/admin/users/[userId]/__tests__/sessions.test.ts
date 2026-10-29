import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findBySid: vi.fn(),
  listUserSessions: vi.fn(),
  revokeSession: vi.fn(),
  logAuthAudit: vi.fn(),
  record: vi.fn(),
  csrfMiddleware: vi.fn(),
  used: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: (mw: unknown) => (mocks.used.push(mw), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => mocks.csrfMiddleware }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
  authSessionRepository: { findBySid: (...a: unknown[]) => mocks.findBySid(...a) },
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  authSessionService: {
    listUserSessions: (...a: unknown[]) => mocks.listUserSessions(...a),
    revokeSession: (...a: unknown[]) => mocks.revokeSession(...a),
  },
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mocks.logAuthAudit(...a) }));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mocks.record(...a),
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || value.length < 3) throw Object.assign(new Error('reason'), { statusCode: 400 });
    return value;
  },
}));

import handler from '../sessions';

const USER_ID = 'b'.repeat(24);
const SESSION = {
  sid: 'sid-1',
  userId: USER_ID,
  createdVia: 'google',
  device: { browser: 'Chrome', os: 'macOS', ip: '192.0.2.4', location: 'Lisbon, PT' },
  refreshTokenHash: 'secret-hash',
  impersonatedBy: undefined,
  lastUsedAt: new Date('2026-10-20T10:00:00.000Z'),
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  expiresAt: new Date('2026-11-01T10:00:00.000Z'),
};

const call = (
  method: 'GET' | 'DELETE',
  {
    query = {},
    body,
    user = { id: 'admin1', sid: 'admin-sid', isAdmin: true },
  }: {
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    user?: unknown;
  } = {}
) => {
  const { req, res } = createMocks({ method, query: { userId: USER_ID, ...query }, body });
  Object.assign(req, { user, logger: { log: vi.fn(), info: vi.fn(), error: vi.fn() } });
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, name: 'Mara Quill' });
  mocks.findBySid.mockResolvedValue(SESSION);
  mocks.listUserSessions.mockResolvedValue([SESSION]);
  mocks.revokeSession.mockResolvedValue(SESSION);
  mocks.record.mockResolvedValue(null);
});

describe('/api/admin/users/[userId]/sessions', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('passes the csrf middleware to the chain', () => {
    expect(mocks.used).toContain(mocks.csrfMiddleware);
  });

  describe('GET', () => {
    it('rejects a non-admin with 403 before reading anything', async () => {
      await expect(call('GET', { user: { id: 'u2', isAdmin: false } }).promise).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(mocks.findById).not.toHaveBeenCalled();
    });

    it('rejects a malformed id with 400 and a missing user with 404', async () => {
      await expect(call('GET', { query: { userId: 'nope' } }).promise).rejects.toMatchObject({ statusCode: 400 });
      mocks.findById.mockResolvedValue(null);
      await expect(call('GET').promise).rejects.toMatchObject({ statusCode: 404 });
    });

    it('lists the active sessions without the refresh-token hash', async () => {
      const { res, promise } = call('GET');
      await promise;
      const { items } = res._getJSONData() as { items: Array<Record<string, unknown>> };
      expect(items).toEqual([
        {
          sid: 'sid-1',
          createdVia: 'google',
          device: SESSION.device,
          lastUsedAt: '2026-10-20T10:00:00.000Z',
          createdAt: '2026-10-01T10:00:00.000Z',
          expiresAt: '2026-11-01T10:00:00.000Z',
          impersonated: false,
          current: false,
        },
      ]);
      expect(JSON.stringify(items)).not.toContain('secret-hash');
    });

    it("flags the admin's own session as current", async () => {
      const { res, promise } = call('GET', { user: { id: 'admin1', sid: 'sid-1', isAdmin: true } });
      await promise;
      const { items } = res._getJSONData() as { items: Array<{ current: boolean }> };
      expect(items[0].current).toBe(true);
    });
  });

  describe('DELETE', () => {
    const revoke = (overrides: Parameters<typeof call>[1] = {}) =>
      call('DELETE', { query: { sid: 'sid-1' }, body: { reason: 'Compromised: lost laptop' }, ...overrides });

    it('rejects a non-admin with 403 and revokes nothing', async () => {
      await expect(revoke({ user: { id: 'u2', isAdmin: false } }).promise).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(mocks.revokeSession).not.toHaveBeenCalled();
    });

    it('requires a sid and a reason', async () => {
      await expect(call('DELETE', { body: { reason: 'Compromised' } }).promise).rejects.toMatchObject({
        statusCode: 422,
      });
      await expect(revoke({ body: {} }).promise).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.revokeSession).not.toHaveBeenCalled();
    });

    it("refuses the admin's own current session", async () => {
      await expect(revoke({ query: { sid: 'admin-sid' } }).promise).rejects.toMatchObject({ statusCode: 422 });
      expect(mocks.revokeSession).not.toHaveBeenCalled();
    });

    it("answers 404 for an unknown sid or another user's session", async () => {
      mocks.findBySid.mockResolvedValue(null);
      await expect(revoke().promise).rejects.toMatchObject({ statusCode: 404 });
      mocks.findBySid.mockResolvedValue({ ...SESSION, userId: 'c'.repeat(24) });
      await expect(revoke().promise).rejects.toMatchObject({ statusCode: 404 });
      expect(mocks.revokeSession).not.toHaveBeenCalled();
    });

    it('answers 404 for an already-revoked session and writes no audit rows', async () => {
      mocks.findBySid.mockResolvedValue({ ...SESSION, revokedAt: new Date('2026-10-21T10:00:00.000Z') });
      await expect(revoke().promise).rejects.toMatchObject({ statusCode: 404 });
      expect(mocks.revokeSession).not.toHaveBeenCalled();
      expect(mocks.logAuthAudit).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it('revokes the session and audits it with the reason', async () => {
      const { req, res, promise } = revoke();
      await promise;

      expect(mocks.revokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
      expect(mocks.logAuthAudit).toHaveBeenCalledWith(req, {
        userId: USER_ID,
        event: 'session_revoked',
        actorUserId: 'admin1',
      });
      expect(mocks.record).toHaveBeenCalledWith(
        req,
        expect.objectContaining({
          action: 'user.session.revoked',
          target: { kind: 'user', id: USER_ID, displayName: 'Mara Quill' },
          reason: 'Compromised: lost laptop',
        })
      );
      expect(res._getJSONData()).toEqual({ message: 'Session revoked', sid: 'sid-1' });
    });
  });
});
