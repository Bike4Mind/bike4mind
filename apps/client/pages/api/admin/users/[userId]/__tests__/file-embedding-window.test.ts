import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  resetFileEmbeddingSpendWindow: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: () => ({
      post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    }),
  }),
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

const makeReq = (body: unknown, isAdmin = true) => ({
  query: { userId: 'user-1' },
  body,
  user: { id: 'admin-1', username: 'admin', isAdmin },
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

describe('POST /api/admin/users/[userId]/file-embedding-window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-admin before touching the window', async () => {
    await expect(h.handler!(makeReq({ reason: REASON }, false), { json: vi.fn() })).rejects.toThrow(/admin/i);

    expect(h.resetFileEmbeddingSpendWindow).not.toHaveBeenCalled();
  });

  it('refuses an unknown user without resetting anything', async () => {
    h.findById.mockResolvedValue(null);

    await expect(h.handler!(makeReq({ reason: REASON }), { json: vi.fn() })).rejects.toThrow(/not found/i);
    expect(h.resetFileEmbeddingSpendWindow).not.toHaveBeenCalled();
  });

  it('resets the user window, audits what it held, and returns it', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@b.test' });
    h.resetFileEmbeddingSpendWindow.mockResolvedValue({ tokens: 1200, microUsd: 30 });
    const json = vi.fn();

    await h.handler!(makeReq({ reason: REASON }), { json });

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
