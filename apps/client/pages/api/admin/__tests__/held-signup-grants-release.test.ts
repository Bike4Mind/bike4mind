import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, baseOptions, release, preview } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  release: vi.fn(),
  preview: vi.fn(),
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
vi.mock('@bike4mind/services', () => ({
  userService: { MAX_BULK_RELEASE: 100, bulkReleaseHeldGrants: release, previewSignupGrantAction: preview },
}));
const findAdminTargetsByIds = vi.hoisted(() => vi.fn());
const userRepository = vi.hoisted(() => ({ repo: true, findAdminTargetsByIds }));
vi.mock('@bike4mind/database', () => ({ userRepository }));
vi.mock('@bike4mind/server-utils/credits/heldSignupGrantAdapters', () => ({
  buildHeldGrantAdapters: () => ({ grant: {} }),
  heldGrantBatches: { batches: true },
}));
const audit = vi.hoisted(() => ({
  record: vi.fn(),
  deny: vi.fn(),
  policy: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  denySelfAdminAction: audit.deny,
  loadCreditGrantPolicy: audit.policy,
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || !value.trim())
      throw Object.assign(new Error('A reason is required'), { statusCode: 400 });
    return value.trim();
  },
  recordAdminActionFromRequest: audit.record,
}));
import '@pages/api/admin/held-signup-grants/release';

const id = (n: number) => String(n).padStart(24, '0');
const REASON = 'verified partner signup';
const run = async (body: unknown, isAdmin = true, user: Record<string, unknown> = {}) => {
  const withReason =
    body && typeof body === 'object' && !Array.isArray(body) && !('reason' in body)
      ? { reason: REASON, ...body }
      : body;
  const { req, res } = createMocks({ method: 'POST', body: withReason });
  Object.assign(req, { user: { id: 'admin-1', isAdmin, ...user }, logger: { error: vi.fn() } });
  await Promise.resolve()
    .then(() => {
      for (const middleware of uses) middleware(req, res, () => undefined);
      return handlers.post(req, res);
    })
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
beforeEach(() => {
  release.mockReset().mockResolvedValue({ batchId: 'b1', results: [] });
  findAdminTargetsByIds.mockReset().mockResolvedValue([]);
  preview.mockReset().mockResolvedValue({ dryRun: true, results: [], undoUserIds: [] });
  audit.record.mockReset();
  audit.policy.mockReset().mockReturnValue({ singleGrantCredits: 10 });
  audit.deny.mockReset().mockRejectedValue(Object.assign(new Error('own account'), { statusCode: 403 }));
});

describe('POST /api/admin/held-signup-grants/release', () => {
  it('guards with the admin scope', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });
  it('rejects non-admins', async () => {
    expect((await run({ userIds: [id(1)] }, false)).statusCode).toBe(403);
    expect(release).not.toHaveBeenCalled();
  });
  it('admits a delegate holding credits:adjust and refuses one without it', async () => {
    expect((await run({ userIds: [id(1)] }, false, { adminPermissions: ['support:read'] })).statusCode).toBe(403);
    expect(release).not.toHaveBeenCalled();
    expect((await run({ userIds: [id(1)] }, false, { adminPermissions: ['credits:adjust'] })).statusCode).toBe(200);
    expect(release).toHaveBeenCalledOnce();
  });
  it.each([
    ['empty ids', { userIds: [] }],
    ['a non-array', { userIds: id(1) }],
    ['a missing body', undefined],
    ['a malformed id', { userIds: ['not-an-id'] }],
    ['over the cap', { userIds: Array.from({ length: 101 }, (_, n) => id(n)) }],
  ])('rejects %s', async (_label, body) => {
    expect((await run(body)).statusCode).toBe(400);
    expect(release).not.toHaveBeenCalled();
  });
  it('releases at exactly the cap and attributes the batch to the admin', async () => {
    const userIds = Array.from({ length: 100 }, (_, n) => id(n));
    const res = await run({ userIds });
    expect(res.statusCode).toBe(200);
    expect(release).toHaveBeenCalledWith(
      { actorId: 'admin-1', userIds },
      expect.objectContaining({ batches: { batches: true } })
    );
  });
  it('writes one audit entry per paid grant and none for skipped ones', async () => {
    release.mockResolvedValue({
      batchId: 'b1',
      results: [
        { userId: id(1), outcome: 'released', credits: 12 },
        { userId: id(2), outcome: 'withheld', credits: 0 },
        { userId: id(3), outcome: 'failed', credits: 0 },
      ],
    });
    await run({ userIds: [id(1), id(2), id(3)] });
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      {
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: id(1), displayName: id(1) },
        summary: 'released held signup grant',
        reason: REASON,
        details: { credits: 12, source: 'held_grant_release', batchId: 'b1' },
      },
      expect.anything()
    );
  });

  describe('reason', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['non-string', 42],
    ])('refuses a %s reason before paying or auditing anything', async (_label, reason) => {
      const body: Record<string, unknown> = { userIds: [id(1)] };
      body.reason = reason;
      expect((await run(body)).statusCode).toBe(400);
      expect(release).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('carries the reason and the large-grant policy into every paid row audit', async () => {
      release.mockResolvedValue({
        batchId: 'b1',
        results: [
          { userId: id(1), outcome: 'released', credits: 500 },
          { userId: id(2), outcome: 'released', credits: 3 },
        ],
      });
      expect((await run({ userIds: [id(1), id(2)], reason: '  bulk review done ' })).statusCode).toBe(200);
      expect(audit.record).toHaveBeenCalledTimes(2);
      for (const call of audit.record.mock.calls) {
        expect(call[1]).toMatchObject({ reason: 'bulk review done' });
        expect(call[2].creditGrantPolicy()).toEqual({ singleGrantCredits: 10 });
      }
      expect(audit.record.mock.calls[0][1].details.credits).toBe(500);
      expect(audit.policy).toHaveBeenCalledTimes(1);
    });
  });
  it.each([
    ['self', { id: id(2) }],
    ['impersonator', { impersonatedBy: id(2) }],
  ])('rejects a request that includes the %s account before paying anything', async (_label, user) => {
    expect((await run({ userIds: [id(1), id(2)] }, true, user)).statusCode).toBe(403);
    expect(audit.deny).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      action: 'user.credits.denied',
      attempted: 'user.credits.adjusted',
      target: { kind: 'user', id: id(2), displayName: id(2) },
    });
    expect(release).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lowercases ids once for the self check, the dry run and the real run', async () => {
    const upper = 'ABCDEF0123456789ABCDEF01';
    const lower = upper.toLowerCase();
    expect((await run({ userIds: [upper] }, true, { id: lower })).statusCode).toBe(403);
    expect(audit.deny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { kind: 'user', id: lower, displayName: lower },
      })
    );

    await run({ userIds: [upper], dryRun: true });
    expect(preview).toHaveBeenCalledWith({ action: 'release_held', userIds: [lower] }, expect.anything());

    await run({ userIds: [upper] });
    expect(release).toHaveBeenCalledWith({ actorId: 'admin-1', userIds: [lower] }, expect.anything());
  });

  describe('dry run', () => {
    it('previews with the held-release classification and pays, audits and records nothing', async () => {
      const res = await run({ userIds: [id(1)], dryRun: true, reason: undefined });

      expect(res.statusCode).toBe(200);
      expect(preview).toHaveBeenCalledExactlyOnceWith(
        { action: 'release_held', userIds: [id(1)] },
        { users: userRepository }
      );
      expect(release).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('still refuses a non-admin and the admin own account', async () => {
      expect((await run({ userIds: [id(1)], dryRun: true }, false)).statusCode).toBe(403);
      expect((await run({ userIds: [id(1)], dryRun: true }, true, { id: id(1) })).statusCode).toBe(403);
      expect(preview).not.toHaveBeenCalled();
    });
  });
  describe('accounts with admin access', () => {
    const otherAdmin = { id: id(2), isAdmin: true };
    const otherDelegate = { id: id(3), adminPermissions: ['support:read'] };
    it.each([
      ['a full admin', otherAdmin],
      ['another delegate', otherDelegate],
    ])('refuses a delegate releasing to %s, dry run included, before anything is paid', async (_label, target) => {
      findAdminTargetsByIds.mockResolvedValue([{ id: id(1) }, target]);
      for (const dryRun of [false, true]) {
        const res = await run({ userIds: [id(1), target.id], dryRun }, false, { adminPermissions: ['credits:adjust'] });
        expect(res.statusCode).toBe(403);
      }
      expect(findAdminTargetsByIds).toHaveBeenCalledWith([id(1), target.id]);
      expect(release).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    });
    it('lets a full admin release to an account with admin access', async () => {
      findAdminTargetsByIds.mockResolvedValue([otherAdmin]);
      expect((await run({ userIds: [otherAdmin.id] })).statusCode).toBe(200);
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
