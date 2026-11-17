import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ForbiddenError,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  freezeSpend: vi.fn(),
  unfreezeSpend: vi.fn(),
  listActiveFreezes: vi.fn(),
  getFreezeHistory: vi.fn(),
  userFindById: vi.fn(),
  userFindByIds: vi.fn(),
  orgFindById: vi.fn(),
  orgFind: vi.fn(),
  keyFindById: vi.fn(),
  keyFind: vi.fn(),
  resolveAudit: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    const guard = (method: string, fn: Handler) => async (req: unknown, res: unknown) => {
      const requirement = options.adminPermissions[method];
      const { user } = req as { user?: Parameters<typeof meetsAdminPermissionRequirement>[0] };
      if (requirement && !meetsAdminPermissionRequirement(user, requirement)) {
        throw new ForbiddenError(missingAdminPermissionMessage(requirement));
      }
      return fn(req, res);
    };
    const handlers: Record<string, Handler> = {};
    const chain = {
      use: () => chain,
      get: (fn: Handler) => {
        handlers.GET = guard('GET', fn);
        return chain;
      },
      post: (fn: Handler) => {
        handlers.POST = guard('POST', fn);
        return chain;
      },
      handle: (req: { method: string }, res: unknown) => handlers[req.method](req, res),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => (_req: unknown, _res: unknown) => {} }));
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  spendFreezeRepository: {},
  adminAuditLogRepository: {},
  userRepository: { findById: h.userFindById, findByIds: h.userFindByIds },
  organizationRepository: { findById: h.orgFindById, find: h.orgFind },
  userApiKeyRepository: { findById: h.keyFindById, find: h.keyFind },
}));
vi.mock('@bike4mind/services', () => ({
  spendFreezeService: {
    freezeSpend: h.freezeSpend,
    unfreezeSpend: h.unfreezeSpend,
    listActiveFreezes: h.listActiveFreezes,
    getFreezeHistory: h.getFreezeHistory,
  },
}));
// Only the audit-actor resolution is stubbed; reason validation is the real shared rule.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  resolveAdminAuditFromRequest: h.resolveAudit,
}));

import indexRoute from '../index';
import liftRoute from '../lift';
import historyRoute from '../history';

const run = async (
  route: unknown,
  {
    method,
    body,
    query,
    user,
  }: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string>; user?: unknown }
) => {
  const { req, res } = createMocks({ method, body: body as Record<string, unknown>, query });
  const augmented = req as unknown as Record<string, unknown>;
  augmented.user = user ?? { id: 'admin-1', isAdmin: true };
  augmented.logger = { info: vi.fn() };
  await (route as { handle: Handler }).handle(req, res);
  return res;
};

const SCOPE_ID = 'a'.repeat(24);
const validBody = { scopeType: 'Organization', scopeId: SCOPE_ID, reason: 'admin review' };
const AUDIT = { actor: { kind: 'user', userId: 'admin-1' }, context: { route: '/x' } };
const freeze = { id: 'f1', scopeType: 'Organization', scopeId: SCOPE_ID, reason: 'r' };

describe('spend freeze admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolveAudit.mockResolvedValue(AUDIT);
    h.orgFindById.mockResolvedValue({ id: SCOPE_ID, name: 'Acme' });
    h.keyFindById.mockResolvedValue({ id: SCOPE_ID, keyPrefix: 'b4m_live_abc' });
    h.userFindById.mockResolvedValue({ id: SCOPE_ID, email: 'u@example.com', isAdmin: false });
    h.freezeSpend.mockResolvedValue({ freeze, created: true });
    h.unfreezeSpend.mockResolvedValue({ freeze, lifted: true });
  });

  describe('POST /spend-freezes', () => {
    it('freezes with the admin actor, audit pair and reason', async () => {
      const res = await run(indexRoute, { method: 'POST', body: validBody });

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ freeze, created: true });
      expect(h.freezeSpend).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { scopeType: 'Organization', scopeId: SCOPE_ID },
          actor: { kind: 'admin', userId: 'admin-1' },
          audit: AUDIT,
          reason: 'admin review',
        }),
        expect.anything()
      );
    });

    it('403s freezing an API key whose owner has admin access when the admin is only a delegate', async () => {
      h.keyFindById.mockResolvedValue({ id: SCOPE_ID, keyPrefix: 'b4m_live_abc', userId: 'owner-1' });
      h.userFindById.mockResolvedValue({ id: 'owner-1', isAdmin: true });

      await expect(
        run(indexRoute, {
          method: 'POST',
          body: { ...validBody, scopeType: 'apiKey' },
          user: { id: 'delegate-1', isAdmin: false, adminPermissions: ['credits:adjust'] },
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(h.freezeSpend).not.toHaveBeenCalled();
    });

    it('reports created:false for a repeated freeze', async () => {
      h.freezeSpend.mockResolvedValue({ freeze, created: false });

      const res = await run(indexRoute, { method: 'POST', body: validBody });

      expect(res._getJSONData()).toEqual({ freeze, created: false });
    });

    it.each([
      ['Organization', 'orgFindById'],
      ['apiKey', 'keyFindById'],
      ['User', 'userFindById'],
    ] as const)('404s an unknown %s scope', async (scopeType, finder) => {
      h[finder].mockResolvedValue(null);

      await expect(run(indexRoute, { method: 'POST', body: { ...validBody, scopeType } })).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(h.freezeSpend).not.toHaveBeenCalled();
    });

    it('400s a missing reason', async () => {
      await expect(
        run(indexRoute, { method: 'POST', body: { scopeType: 'Organization', scopeId: SCOPE_ID } })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(h.freezeSpend).not.toHaveBeenCalled();
    });

    it('400s a malformed scope id', async () => {
      await expect(run(indexRoute, { method: 'POST', body: { ...validBody, scopeId: 'nope' } })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('403s an admin without credits:adjust', async () => {
      await expect(
        run(indexRoute, {
          method: 'POST',
          body: validBody,
          user: { id: 'a2', isAdmin: false, adminPermissions: ['support:read'] },
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(h.freezeSpend).not.toHaveBeenCalled();
    });

    it('403s a non-admin', async () => {
      await expect(
        run(indexRoute, { method: 'POST', body: validBody, user: { id: 'u', isAdmin: false } })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe.each([
    ['POST /spend-freezes', indexRoute],
    ['POST /spend-freezes/lift', liftRoute],
  ])('%s reason bounds', (_name, route) => {
    it.each([
      ['4-char', 'abcd'],
      ['501-char', 'a'.repeat(501)],
    ])('400s a %s reason', async (_label, reason) => {
      await expect(run(route, { method: 'POST', body: { ...validBody, reason } })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(h.freezeSpend).not.toHaveBeenCalled();
      expect(h.unfreezeSpend).not.toHaveBeenCalled();
    });

    it.each([
      ['5-char', 'abcde'],
      ['500-char', 'a'.repeat(500)],
    ])('accepts a %s reason', async (_label, reason) => {
      const res = await run(route, { method: 'POST', body: { ...validBody, reason } });

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe('GET /spend-freezes', () => {
    it('labels each freeze: email, organization name, key prefix, with batched lookups', async () => {
      const userId = 'b'.repeat(24);
      const keyId = 'c'.repeat(24);
      h.listActiveFreezes.mockResolvedValue({
        items: [
          { ...freeze },
          { ...freeze, id: 'f2', scopeType: 'User', scopeId: userId },
          { ...freeze, id: 'f3', scopeType: 'apiKey', scopeId: keyId },
        ],
        nextCursor: 'next',
      });
      h.orgFind.mockResolvedValue([{ id: SCOPE_ID, name: 'Acme' }]);
      h.userFindByIds.mockResolvedValue([{ id: userId, email: 'u@example.com', username: 'u' }]);
      h.keyFind.mockResolvedValue([{ id: keyId, keyPrefix: 'b4m_live_abc' }]);

      const res = await run(indexRoute, { method: 'GET', query: { limit: '10' } });

      const body = res._getJSONData();
      expect(body.nextCursor).toBe('next');
      expect(body.items.map((item: { label: string }) => item.label)).toEqual([
        'Acme',
        'u@example.com',
        'b4m_live_abc',
      ]);
      expect(h.orgFind).toHaveBeenCalledTimes(1);
      expect(h.userFindByIds).toHaveBeenCalledTimes(1);
      expect(h.keyFind).toHaveBeenCalledTimes(1);
      expect(h.listActiveFreezes).toHaveBeenCalledWith({ limit: 10 }, expect.anything());
    });

    it('lets a support:read delegate list', async () => {
      h.listActiveFreezes.mockResolvedValue({ items: [], nextCursor: null });

      const res = await run(indexRoute, {
        method: 'GET',
        user: { id: 'a2', isAdmin: false, adminPermissions: ['support:read'] },
      });

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe('POST /spend-freezes/lift', () => {
    it('lifts and reports lifted:true', async () => {
      const res = await run(liftRoute, { method: 'POST', body: validBody });

      expect(res._getJSONData()).toEqual({ freeze, lifted: true });
      expect(h.unfreezeSpend).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { kind: 'admin', userId: 'admin-1' }, reason: 'admin review' }),
        expect.anything()
      );
    });

    it('still lifts when the scope no longer exists', async () => {
      h.orgFindById.mockResolvedValue(null);

      const res = await run(liftRoute, { method: 'POST', body: validBody });

      expect(res._getStatusCode()).toBe(200);
    });

    it('400s a missing reason', async () => {
      await expect(
        run(liftRoute, { method: 'POST', body: { scopeType: 'Organization', scopeId: SCOPE_ID } })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('403s a non-admin', async () => {
      await expect(
        run(liftRoute, { method: 'POST', body: validBody, user: { id: 'u', isAdmin: false } })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('GET /spend-freezes/history', () => {
    it('returns the scope history', async () => {
      h.getFreezeHistory.mockResolvedValue({ items: [freeze], nextCursor: 'c2' });

      const res = await run(historyRoute, {
        method: 'GET',
        query: { scopeType: 'Organization', scopeId: SCOPE_ID },
      });

      expect(res._getJSONData()).toEqual({ items: [freeze], nextCursor: 'c2' });
      expect(h.getFreezeHistory).toHaveBeenCalledWith(
        { scopeType: 'Organization', scopeId: SCOPE_ID },
        50,
        undefined,
        expect.anything()
      );
    });

    it('passes the cursor and limit through', async () => {
      h.getFreezeHistory.mockResolvedValue({ items: [], nextCursor: null });

      await run(historyRoute, {
        method: 'GET',
        query: { scopeType: 'Organization', scopeId: SCOPE_ID, limit: '10', cursor: 'c1' },
      });

      expect(h.getFreezeHistory).toHaveBeenCalledWith(
        { scopeType: 'Organization', scopeId: SCOPE_ID },
        10,
        'c1',
        expect.anything()
      );
    });

    it('400s an invalid scope', async () => {
      await expect(run(historyRoute, { method: 'GET', query: { scopeType: 'Nope' } })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });
});
