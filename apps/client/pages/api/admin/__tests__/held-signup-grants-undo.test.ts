import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { handlers, baseOptions, undo } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  undo: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({ creditTransactionRepository: {}, userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { undoHeldGrantRelease: undo } }));
vi.mock('@server/credits/heldSignupGrantAdapters', () => ({ heldGrantBatches: {} }));
import '@pages/api/admin/held-signup-grants/undo';

const run = async (body: unknown, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin }, logger: {} });
  await handlers
    .post(req, res)
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
beforeEach(() => undo.mockReset().mockResolvedValue({ batchId: 'b', results: [] }));

describe('POST /api/admin/held-signup-grants/undo', () => {
  it('guards with the admin scope', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
  });
  it('rejects non-admins', async () => {
    expect((await run({ batchId: 'a'.repeat(24) }, false)).statusCode).toBe(403);
    expect(undo).not.toHaveBeenCalled();
  });
  it.each([
    ['missing', {}],
    ['malformed', { batchId: 'x' }],
    ['non-string', { batchId: 5 }],
  ])('rejects a %s batchId', async (_l, body) => {
    expect((await run(body)).statusCode).toBe(400);
    expect(undo).not.toHaveBeenCalled();
  });
  it('404s an unknown batch', async () => {
    undo.mockResolvedValue(null);
    expect((await run({ batchId: 'a'.repeat(24) })).statusCode).toBe(404);
  });
  it('returns the per-user outcomes', async () => {
    undo.mockResolvedValue({ batchId: 'b', results: [{ userId: 'u', outcome: 'reversed', credits: 12 }] });
    const res = await run({ batchId: 'a'.repeat(24) });
    expect(res._getJSONData().results[0].outcome).toBe('reversed');
    expect(undo).toHaveBeenCalledWith({ batchId: 'a'.repeat(24), actorId: 'admin-1' }, expect.anything());
  });
});
