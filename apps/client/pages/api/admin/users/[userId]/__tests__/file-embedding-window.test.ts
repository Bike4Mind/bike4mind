import { describe, it, expect, vi, beforeEach } from 'vitest';

type Guard = (req: unknown, res: unknown, next: () => void) => void;

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  guard: null as null | Guard,
  options: null as null | Record<string, unknown>,
  findById: vi.fn(),
  resetFileEmbeddingSpendWindow: vi.fn(),
}));

// adminApi stays real: the permission guard it installs is part of what is under test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: Record<string, unknown>) => {
    h.options = options;
    const chain = {
      use: (middleware: Guard) => {
        // The first middleware is adminApi's permission guard; csrfProtection is mocked out below.
        h.guard ??= middleware;
        return chain;
      },
      post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { name: 'cache' },
  userRepository: { findById: h.findById },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  fileEmbeddingService: { resetFileEmbeddingSpendWindow: h.resetFileEmbeddingSpendWindow },
}));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

await import('../file-embedding-window');

const REASON = 'Re-indexing after a support request';

type Actor = { isAdmin?: boolean; adminPermissions?: string[] };

const makeReq = (body: unknown, actor: Actor = { isAdmin: true }) => ({
  method: 'POST',
  query: { userId: 'user-1' },
  body,
  user: { id: 'admin-1', username: 'admin', ...actor },
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

const call = async (body: unknown, res: unknown, actor?: Actor) => {
  const req = makeReq(body, actor);
  h.guard!(req, res, () => {});
  return h.handler!(req, res);
};

describe('POST /api/admin/users/[userId]/file-embedding-window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares first-party JWT-only authentication and only POST', () => {
    expect(h.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });

  it.each([
    ['an ordinary user', { isAdmin: false }],
    ['a support-only delegate', { isAdmin: false, adminPermissions: ['support:read'] }],
  ])('refuses %s before touching the window', async (_name, actor) => {
    await expect(call({ reason: REASON }, { json: vi.fn() }, actor)).rejects.toMatchObject({ statusCode: 403 });

    expect(h.findById).not.toHaveBeenCalled();
    expect(h.resetFileEmbeddingSpendWindow).not.toHaveBeenCalled();
  });

  it('lets a settings:manage delegate reset the window', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@b.test' });
    h.resetFileEmbeddingSpendWindow.mockResolvedValue({ tokens: 0, microUsd: 0 });
    const json = vi.fn();

    await call({ reason: REASON }, { json }, { isAdmin: false, adminPermissions: ['settings:manage'] });

    expect(h.resetFileEmbeddingSpendWindow).toHaveBeenCalledWith('user-1', { cache: { name: 'cache' } });
  });

  it('refuses an unknown user without resetting anything', async () => {
    h.findById.mockResolvedValue(null);

    await expect(call({ reason: REASON }, { json: vi.fn() })).rejects.toThrow(/not found/i);
    expect(h.resetFileEmbeddingSpendWindow).not.toHaveBeenCalled();
  });

  it('resets the user window, audits what it held, and returns it', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@b.test' });
    h.resetFileEmbeddingSpendWindow.mockResolvedValue({ tokens: 1200, microUsd: 30 });
    const json = vi.fn();

    await call({ reason: REASON }, { json });

    expect(h.resetFileEmbeddingSpendWindow).toHaveBeenCalledWith('user-1', { cache: { name: 'cache' } });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.file_embedding_window.reset',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [
          { field: 'fileEmbeddingWindowTokens', before: 1200, after: 0 },
          { field: 'fileEmbeddingWindowMicroUsd', before: 30, after: 0 },
        ],
      })
    );
    expect(json).toHaveBeenCalledWith({ reset: true, before: { tokens: 1200, microUsd: 30 } });
  });
});
