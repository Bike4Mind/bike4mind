import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
type Middleware = (req: unknown, res: unknown, next: () => void) => void;

const captured = vi.hoisted(() => ({ middlewares: [] as Middleware[], handlers: {} as Record<string, Handler> }));
const { mockSetActive, mockAudit } = vi.hoisted(() => ({ mockSetActive: vi.fn(), mockAudit: vi.fn() }));

// Keeps the real adminApi permission gate: it runs as a captured middleware ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use(fn: Middleware) {
        captured.middlewares.push(fn);
        return this;
      },
      patch(fn: Handler) {
        captured.handlers.PATCH = fn;
        return this;
      },
    };
    return chain;
  },
}));
vi.mock('@server/preferenceArena', () => ({ getArenaService: () => ({ setPairActive: mockSetActive }) }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: mockAudit }));

import '../pairs/[id]';

const patch = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'PATCH', body: body as never, query: { id: 'pair-1' } });
  Object.assign(req, { user: { id: 'admin1', isAdmin: true }, logger: { error: vi.fn() } });
  for (const middleware of captured.middlewares) middleware(req, res, () => undefined);
  await captured.handlers.PATCH(req, res);
  return res;
};

describe('admin arena pair retire/restore route', () => {
  beforeEach(() => {
    mockSetActive.mockReset().mockResolvedValue(undefined);
    mockAudit.mockReset();
  });

  it.each([
    [false, 'settings.arena_pair.retired'],
    [true, 'settings.arena_pair.restored'],
  ])('records active=%s as %s', async (active, action) => {
    const res = await patch({ active });
    expect(mockSetActive).toHaveBeenCalledWith('pair-1', active);
    expect(res._getJSONData()).toEqual({ active });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action, target: expect.objectContaining({ id: 'pair-1' }) })
    );
  });

  it('writes no audit row when the pair does not exist', async () => {
    mockSetActive.mockRejectedValue(Object.assign(new Error('Pair not found'), { statusCode: 404 }));
    await expect(patch({ active: false })).rejects.toThrow('Pair not found');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
