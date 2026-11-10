import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, baseOptions, revoke } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
const uses = vi.hoisted(() => [] as Array<(req: unknown, res: unknown, next: () => void) => void>);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      use: (fn: unknown) => {
        if (typeof fn === 'function') uses.push(fn as (typeof uses)[number]);
        return chain;
      },
      get: (fn: typeof handlers.get) => {
        handlers.get = fn;
        return chain;
      },
      post: (fn: typeof handlers.post) => {
        handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
const findAdminTargetsByIds = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ creditTransactionRepository: {}, userRepository: { findAdminTargetsByIds } }));
vi.mock('@bike4mind/services', () => ({ userService: { revokeHeldGrantRelease: revoke } }));
const findBatch = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/credits/heldSignupGrantAdapters', () => ({ heldGrantBatches: { findBatch } }));
const audit = vi.hoisted(() => ({
  record: vi.fn(),
  deny: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  denySelfAdminAction: audit.deny,
  loadCreditGrantPolicy: vi.fn(),
  recordAdminActionFromRequest: audit.record,
}));

import '@pages/api/admin/held-signup-grants/revoke';

const run = async (body: unknown, isAdmin = true, user: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin, ...user }, logger: { error: vi.fn() } });
  await Promise.resolve()
    .then(() => {
      for (const middleware of uses) middleware(req, res, () => undefined);
      return handlers.post(req, res);
    })
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
const BATCH = 'a'.repeat(24);
beforeEach(() => {
  revoke.mockReset().mockResolvedValue({ batchId: 'b', results: [] });
  findAdminTargetsByIds.mockReset().mockResolvedValue([]);
  findBatch.mockReset().mockResolvedValue({
    id: BATCH,
    actorId: 'x',
    entries: [{ userId: 'u', outcome: 'released', credits: 12 }],
  });
  audit.record.mockReset();
  audit.deny.mockReset().mockRejectedValue(Object.assign(new Error('own account'), { statusCode: 403 }));
});

describe('POST /api/admin/held-signup-grants/revoke', () => {
  it('guards with the admin scope', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });
  it('rejects non-admins', async () => {
    expect((await run({ batchId: 'a'.repeat(24) }, false)).statusCode).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });
  it('admits a delegate holding credits:adjust and refuses one without it', async () => {
    expect((await run({ batchId: BATCH }, false, { adminPermissions: ['support:read'] })).statusCode).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    expect((await run({ batchId: BATCH }, false, { adminPermissions: ['credits:adjust'] })).statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledOnce();
  });
  it.each([
    ['missing', {}],
    ['malformed', { batchId: 'x' }],
    ['non-string', { batchId: 5 }],
  ])('rejects a %s batchId', async (_l, body) => {
    expect((await run(body)).statusCode).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });
  it('404s an unknown batch', async () => {
    findBatch.mockResolvedValue(null);
    expect((await run({ batchId: 'a'.repeat(24) })).statusCode).toBe(404);
  });
  it('returns the per-user outcomes', async () => {
    revoke.mockResolvedValue({
      batchId: 'b',
      results: [{ userId: 'u', outcome: 'reversed', credits: 12, heldRestored: true }],
    });
    const res = await run({ batchId: 'a'.repeat(24) });
    expect(res._getJSONData().results[0]).toMatchObject({ outcome: 'reversed', heldRestored: true });
    expect(revoke).toHaveBeenCalledWith({ batchId: 'a'.repeat(24), actorId: 'admin-1' }, expect.anything());
  });
  it('writes one audit entry per revoked account', async () => {
    revoke.mockResolvedValue({
      batchId: 'b',
      results: [
        { userId: 'u', outcome: 'reversed', credits: 12 },
        { userId: 'v', outcome: 'insufficient_balance', credits: 5 },
      ],
    });
    await run({ batchId: BATCH });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: 'u', displayName: 'u' },
        summary: 'revoked released signup grant',
        details: { credits: -12, source: 'held_grant_revoke', batchId: 'b' },
      },
      expect.anything()
    );
  });
  it('records in the audit entry that the account went back to the held queue', async () => {
    revoke.mockResolvedValue({
      batchId: 'b',
      results: [{ userId: 'u', outcome: 'reversed', credits: 12, heldRestored: true }],
    });
    await run({ batchId: BATCH });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: 'u', displayName: 'u' },
        summary: 'revoked released signup grant and returned it to the held queue',
        details: { credits: -12, source: 'held_grant_revoke', batchId: 'b', heldRestored: true },
      },
      expect.anything()
    );
  });
  it('writes no audit entry when nothing was revoked', async () => {
    revoke.mockResolvedValue({ batchId: 'b', results: [{ userId: 'u', outcome: 'failed', credits: 12 }] });
    expect((await run({ batchId: BATCH })).statusCode).toBe(200);
    expect(audit.record).not.toHaveBeenCalled();
  });
  it.each([
    ['self', { id: 'u' }],
    ['impersonator', { impersonatedBy: 'U' }],
  ])('rejects a batch that includes the %s account before revoking', async (_label, user) => {
    expect((await run({ batchId: BATCH }, true, user)).statusCode).toBe(403);
    expect(audit.deny).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      action: 'user.credits.denied',
      attempted: 'user.credits.adjusted',
      target: { kind: 'user', id: 'u', displayName: 'u' },
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
  it.each([
    ['a full admin', { id: 'u', isAdmin: true }],
    ['another delegate', { id: 'u', adminPermissions: ['support:read'] }],
  ])('refuses a delegate revoking a release paid to %s before anything is reversed', async (_label, target) => {
    findAdminTargetsByIds.mockResolvedValue([target]);
    const res = await run({ batchId: BATCH }, false, { adminPermissions: ['credits:adjust'] });
    expect(res.statusCode).toBe(403);
    expect(findAdminTargetsByIds).toHaveBeenCalledWith(['u']);
    expect(revoke).not.toHaveBeenCalled();
  });
  it('lets a full admin revoke a release paid to an account with admin access', async () => {
    findAdminTargetsByIds.mockResolvedValue([{ id: 'u', isAdmin: true }]);
    expect((await run({ batchId: BATCH })).statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledOnce();
  });
});
