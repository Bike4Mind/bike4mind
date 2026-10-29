import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { handlers, baseOptions, release } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      use: () => chain,
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
  userService: { MAX_BULK_RELEASE: 100, bulkReleaseHeldGrants: release },
}));
vi.mock('@server/credits/heldSignupGrantAdapters', () => ({
  buildHeldGrantAdapters: () => ({ grant: {} }),
  heldGrantBatches: { batches: true },
}));
const audit = vi.hoisted(() => ({
  record: vi.fn(),
  deny: vi.fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  denySelfAdminAction: audit.deny,
  loadCreditGrantPolicy: vi.fn(),
  recordAdminActionFromRequest: audit.record,
}));
import '@pages/api/admin/held-signup-grants/release';

const id = (n: number) => String(n).padStart(24, '0');
const run = async (body: unknown, isAdmin = true, user: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin, ...user }, logger: { error: vi.fn() } });
  await handlers
    .post(req, res)
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
beforeEach(() => {
  release.mockReset().mockResolvedValue({ batchId: 'b1', results: [] });
  audit.record.mockReset();
  audit.deny.mockReset().mockRejectedValue(Object.assign(new Error('own account'), { statusCode: 403 }));
});

describe('POST /api/admin/held-signup-grants/release', () => {
  it('guards with the admin scope', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
  });
  it('rejects non-admins', async () => {
    expect((await run({ userIds: [id(1)] }, false)).statusCode).toBe(403);
    expect(release).not.toHaveBeenCalled();
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
        details: { credits: 12, source: 'held_grant_release', batchId: 'b1' },
      },
      expect.anything()
    );
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
});
