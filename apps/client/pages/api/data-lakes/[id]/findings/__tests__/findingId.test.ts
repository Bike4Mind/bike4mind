import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  assertDataLakeWriteScope: vi.fn(),
  findById: vi.fn(),
  resolveFinding: vi.fn(),
  assignFinding: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'curator-1', isAdmin: false })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => unknown) => unknown)[] = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        let index = 0;
        const next = async (): Promise<unknown> => {
          const middleware = middlewares[index++];
          if (middleware) return middleware(req, res, next);
          return routes[req.method ?? 'POST']?.(req, res);
        };
        return next();
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => unknown) => unknown) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({
  DATA_LAKE_READ_SCOPES: [],
  assertDataLakeWriteScope: h.assertDataLakeWriteScope,
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeWriteAccess: h.assertLakeWriteAccess },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeFindingRepository: {
    findById: h.findById,
    resolveFinding: h.resolveFinding,
    assignFinding: h.assignFinding,
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../[findingId]';

const lake = { id: 'lakeDoc1' };
const existing = { id: 'f1', lakeId: 'lakeDoc1', status: 'open' };

const invoke = (body: Record<string, unknown>) => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', query: { id: 'lake1', findingId: 'f1' }, body, user: { id: 'curator-1' } },
      res
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.findById.mockResolvedValue(existing);
  h.resolveFinding.mockImplementation(async (_id, input) => ({ ...existing, ...input }));
  h.assignFinding.mockImplementation(async (_id, assigneeUserId) => ({ ...existing, assigneeUserId }));
});

describe('POST /api/data-lakes/[id]/findings/[findingId] (#3039)', () => {
  it('gates on manage access and on the write scope', async () => {
    const { done } = invoke({ action: 'resolve' });
    await done;

    expect(h.assertLakeWriteAccess).toHaveBeenCalledTimes(1);
    expect(h.assertDataLakeWriteScope).toHaveBeenCalledTimes(1);
  });

  it('refuses a finding belonging to ANOTHER lake', async () => {
    // The gate above authorized a LAKE. Without this check a caller who manages one lake could rule
    // on any finding id in the database by quoting their own lake in the URL.
    h.findById.mockResolvedValue({ ...existing, lakeId: 'someone-elses-lake' });

    await expect(invoke({ action: 'resolve' }).done).rejects.toThrow(/not found/i);
    expect(h.resolveFinding).not.toHaveBeenCalled();
  });

  it('refuses a finding that does not exist', async () => {
    h.findById.mockResolvedValue(null);

    await expect(invoke({ action: 'resolve' }).done).rejects.toThrow(/not found/i);
    expect(h.resolveFinding).not.toHaveBeenCalled();
  });

  it('resolves, stamping the caller as the resolver rather than trusting the body', async () => {
    const { json, done } = invoke({ action: 'resolve', resolution: 'corrected the stale figure' });
    await done;

    const [id, input] = h.resolveFinding.mock.calls[0];
    expect(id).toBe('f1');
    expect(input.status).toBe('resolved');
    expect(input.resolvedByUserId).toBe('curator-1');
    expect(input.resolution).toBe('corrected the stale figure');
    expect(input.resolvedAt).toBeInstanceOf(Date);
    expect(json.mock.calls[0][0].data.status).toBe('resolved');
  });

  it('dismisses through the same door, so the action IS the terminal status', async () => {
    const { done } = invoke({ action: 'dismiss' });
    await done;

    expect(h.resolveFinding.mock.calls[0][1].status).toBe('dismissed');
  });

  it('reports an already-ruled finding as a bad request, not as a missing one', async () => {
    // Null from the compare-and-set means the row was not open - a race or a double-click. The
    // belongs-to-lake read above already proved the row exists, so a 404 here would be a lie.
    h.resolveFinding.mockResolvedValue(null);

    await expect(invoke({ action: 'resolve' }).done).rejects.toThrow(/already been ruled on/i);
  });

  it('assigns and unassigns without touching the resolution path', async () => {
    const { json, done } = invoke({ action: 'assign', assigneeUserId: 'curator-2' });
    await done;

    expect(h.assignFinding).toHaveBeenCalledWith('f1', 'curator-2');
    expect(h.resolveFinding).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].data.assigneeUserId).toBe('curator-2');

    vi.clearAllMocks();
    h.assertLakeWriteAccess.mockResolvedValue(lake);
    h.findById.mockResolvedValue(existing);
    h.assignFinding.mockResolvedValue({ ...existing, assigneeUserId: null });

    const cleared = invoke({ action: 'assign', assigneeUserId: null });
    await cleared.done;

    // Null has to be sayable: otherwise "unassign" is indistinguishable from "leave it alone".
    expect(h.assignFinding).toHaveBeenCalledWith('f1', null);
  });

  it('rejects an unknown action rather than falling through to a resolution', async () => {
    await expect(invoke({ action: 'delete' }).done).rejects.toThrow();
    await expect(invoke({}).done).rejects.toThrow();
    expect(h.resolveFinding).not.toHaveBeenCalled();
    expect(h.assignFinding).not.toHaveBeenCalled();
  });

  it('rejects an assign with no assignee field, which would otherwise read as an unassign', async () => {
    await expect(invoke({ action: 'assign' }).done).rejects.toThrow();
    expect(h.assignFinding).not.toHaveBeenCalled();
  });

  it('refuses a resolution note past the cap', async () => {
    await expect(invoke({ action: 'resolve', resolution: 'x'.repeat(501) }).done).rejects.toThrow();
    expect(h.resolveFinding).not.toHaveBeenCalled();
  });
});
