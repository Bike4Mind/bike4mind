import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  undo: vi.fn(),
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as { limit: () => number; windowMs: number; bucket: string } | undefined,
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      options,
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: NonNullable<typeof h.rateLimitOptions>) => {
    h.rateLimitOptions = options;
    return () => {};
  },
}));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/research/undoHandler', () => ({ undoLakeConfigChangeHandler: h.undo }));

import handler from '../undo';

const call = async () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'POST', query: { id: 'lake1', eventId: 'evt1' } } as never,
    res
  );
  return json;
};

describe('POST /api/data-lakes/:id/config-history/:eventId/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.undo.mockResolvedValue({ entry: null, notes: [] });
  });

  it('runs the undo with the ids from the path and wraps the result', async () => {
    const json = await call();

    expect(h.undo).toHaveBeenCalledWith(expect.anything(), 'lake1', 'evt1', expect.objectContaining({ userId: 'u1' }));
    expect(json).toHaveBeenCalledWith({ data: { entry: null, notes: [] } });
  });

  it.each([
    ['read-only caller', 'Forbidden'],
    ['unknown event', 'Not found'],
    ['later change touched the item', 'Conflict'],
  ])('lets the %s refusal propagate untouched', async (_label, message) => {
    h.undo.mockRejectedValueOnce(new Error(message));
    await expect(call()).rejects.toThrow(message);
  });

  it('accepts a signed-in session only, never an API key', () => {
    expect(h.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('rate limits in one bucket across lakes and events', () => {
    expect(h.rateLimitOptions?.bucket).toBe('data-lakes/config-history-undo');
    expect(h.rateLimitOptions?.windowMs).toBe(60 * 60 * 1000);
  });
});
