import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findLinkStatesByIds: vi.fn(),
  propagateBatchAccountRisk: vi.fn(),
  audit: vi.fn(),
}));

// adminApi stays real: the permission guard it installs through use() is part of what is under test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const guards: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const chain = Object.assign(
      (req: unknown, res: unknown) => {
        for (const guard of guards) guard(req, res, () => {});
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (guard: (req: unknown, res: unknown, next: () => void) => void) => (guards.push(guard), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findLinkStatesByIds: (...a: unknown[]) => mocks.findLinkStatesByIds(...a) },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mocks.audit(...a),
}));
vi.mock('@server/billing/linkedAccounts', () => ({
  propagateBatchAccountRisk: (...a: unknown[]) => mocks.propagateBatchAccountRisk(...a),
}));

import handler from '../linked-suspend-propagation';

const ONE = 'a'.repeat(24);
const TWO = 'b'.repeat(24);
const ACTIVE = 'c'.repeat(24);

const call = (body: unknown, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = { info: vi.fn(), error: vi.fn() };
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const state = (id: string, isBanned: boolean) => ({ id, isBanned });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findLinkStatesByIds.mockImplementation(async (ids: string[]) => ids.map(id => state(id, id !== ACTIVE)));
  mocks.propagateBatchAccountRisk.mockResolvedValue({ locked: [], review: ['x'] });
});

describe('POST /api/admin/users/linked-suspend-propagation', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin before reading anything', async () => {
    expect(() => call({ userIds: [ONE] }, { id: 'u2', isAdmin: false })).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
    expect(mocks.findLinkStatesByIds).not.toHaveBeenCalled();
  });

  it('admits a delegated admin holding users:moderate, and no other grant', async () => {
    expect(() => call({ userIds: [ONE] }, { id: 'u3', adminPermissions: ['support:read'] })).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
    await call({ userIds: [ONE] }, { id: 'u4', adminPermissions: ['users:moderate'] }).promise;
    expect(mocks.propagateBatchAccountRisk).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or oversized id lists', async () => {
    await expect(call({ userIds: ['nope'] }).promise).rejects.toThrow();
    await expect(call({ userIds: [] }).promise).rejects.toThrow();
    await expect(call({ userIds: Array.from({ length: 101 }, () => ONE) }).promise).rejects.toThrow();
    expect(mocks.propagateBatchAccountRisk).not.toHaveBeenCalled();
  });

  it('propagates once for the suspended accounts of the action, never for ones still active', async () => {
    const { res, promise } = call({ userIds: [TWO, ONE, ACTIVE, ONE] });
    await promise;

    expect(mocks.propagateBatchAccountRisk).toHaveBeenCalledTimes(1);
    expect(mocks.propagateBatchAccountRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUserIds: [ONE, TWO],
        trigger: 'suspended together by an admin',
        key: expect.stringMatching(/^admin-bulk-block:[0-9a-f]{32}:\d+$/),
      }),
      expect.anything()
    );
    expect(res._getJSONData()).toEqual({ locked: [], review: ['x'] });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.linked_accounts.propagated',
        details: { sourceUserIds: [ONE, TWO], locked: [], review: ['x'] },
      })
    );
  });

  it('does nothing when none of the accounts is suspended', async () => {
    const { res, promise } = call({ userIds: [ACTIVE] });
    await promise;
    expect(mocks.propagateBatchAccountRisk).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ locked: [], review: [] });
  });
});
