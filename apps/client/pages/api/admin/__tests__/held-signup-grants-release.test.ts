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
import '@pages/api/admin/held-signup-grants/release';

const id = (n: number) => String(n).padStart(24, '0');
const run = async (body: unknown, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin }, logger: {} });
  await handlers
    .post(req, res)
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
beforeEach(() => release.mockReset().mockResolvedValue({ batchId: 'b1', results: [] }));

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
});
