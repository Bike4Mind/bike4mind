import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The PUT handler is the authoritative write boundary for a lake's preferred prompt: it is the one
 * place that owns the session-activatable allowlist, so a non-activatable id must be rejected here
 * (fail loud) rather than stored for the session resolver to silently drop later. These pin that
 * the allowlist check is WIRED into the handler and runs BEFORE the update reaches the service.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  updateDataLake: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeBatchRepository: {},
  fabFileRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
// Real allowlist predicate on purpose - the whole point is which ids pass.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    updateDataLake: h.updateDataLake,
  },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const put = (body: Record<string, unknown>) => ({ method: 'PUT', query: { id: 'lake1' }, body }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('PUT /api/data-lakes/[id] - preferredSystemPromptId allowlist is enforced at the write boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.updateDataLake.mockResolvedValue({ id: 'lake1', preferredSystemPromptId: 'triage_router' });
  });

  it('rejects a non-activatable prompt id BEFORE touching the service', async () => {
    const { res } = makeRes();
    await expect(run(put({ name: 'L', preferredSystemPromptId: 'totally_made_up' }), res)).rejects.toThrow(
      /not a valid preferred system prompt/i
    );
    // Fail loud and early: neither the access gate nor the update ran.
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
    expect(h.updateDataLake).not.toHaveBeenCalled();
  });

  it('accepts an activatable id and forwards it to the update service', async () => {
    const { res, json } = makeRes();
    await run(put({ name: 'L', preferredSystemPromptId: 'triage_router' }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      { userId: 'owner', isAdmin: false },
      'lake1',
      expect.objectContaining({ preferredSystemPromptId: 'triage_router' }),
      expect.anything()
    );
    expect(json.mock.calls[0][0].preferredSystemPromptId).toBe('triage_router');
  });

  it('accepts the empty-string clear sentinel (removing the binding)', async () => {
    const { res } = makeRes();
    await run(put({ name: 'L', preferredSystemPromptId: '' }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      expect.objectContaining({ preferredSystemPromptId: '' }),
      expect.anything()
    );
  });
});
