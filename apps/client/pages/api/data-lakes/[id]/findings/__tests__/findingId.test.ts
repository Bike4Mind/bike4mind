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

const invoke = (body: Record<string, unknown>, findingId = 'f1') => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', query: { id: 'lake1', findingId }, body, user: { id: 'curator-1' } },
      res
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.findById.mockResolvedValue(existing);
  h.resolveFinding.mockImplementation(async (_lakeId, _id, input) => ({ ...existing, ...input }));
  h.assignFinding.mockImplementation(async (_lakeId, _id, assigneeUserId) => ({ ...existing, assigneeUserId }));
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

    const [lakeId, id, input] = h.resolveFinding.mock.calls[0];
    // Lake-scoped in the FILTER, not just checked above it: belongs-to-lake is a property of the
    // write, so a future caller that skips the route's guard still cannot reach another lake's row.
    expect(lakeId).toBe('lakeDoc1');
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

    expect(h.resolveFinding.mock.calls[0][2].status).toBe('dismissed');
  });

  it('reports an already-ruled finding as a bad request, not as a missing one', async () => {
    // Null from the compare-and-set means the row was not open - a race or a double-click. The
    // re-read below it confirms the row is still there, so a 404 here would be a lie.
    h.resolveFinding.mockResolvedValue(null);

    await expect(invoke({ action: 'resolve' }).done).rejects.toThrow(/already been ruled on/i);
  });

  it('reports a row DELETED between the read and the CAS as not-found, not as already-ruled', async () => {
    // The other thing a null from the compare-and-set can mean, and the reason it is re-read. A
    // lake teardown or a source purge can sweep the row mid-request; answering "this finding has
    // already been ruled on" then describes a row that no longer exists, and disagrees with the
    // assign branch, which 404s the identical case.
    h.resolveFinding.mockResolvedValue(null);
    h.findById.mockResolvedValueOnce(existing).mockResolvedValueOnce(null);

    await expect(invoke({ action: 'resolve' }).done).rejects.toThrow(/not found/i);
  });

  it('assigns and unassigns without touching the resolution path', async () => {
    const { json, done } = invoke({ action: 'assign', assigneeUserId: 'curator-2' });
    await done;

    expect(h.assignFinding).toHaveBeenCalledWith('lakeDoc1', 'f1', 'curator-2');
    expect(h.resolveFinding).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].data.assigneeUserId).toBe('curator-2');

    vi.clearAllMocks();
    h.assertLakeWriteAccess.mockResolvedValue(lake);
    h.findById.mockResolvedValue(existing);
    h.assignFinding.mockResolvedValue({ ...existing, assigneeUserId: null });

    const cleared = invoke({ action: 'assign', assigneeUserId: null });
    await cleared.done;

    // Null has to be sayable: otherwise "unassign" is indistinguishable from "leave it alone".
    expect(h.assignFinding).toHaveBeenCalledWith('lakeDoc1', 'f1', null);
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

  it('reports a vanished row on the assign path as not-found, not as a success', async () => {
    // The belongs-to-lake read proved the row existed a moment ago; a null here means it was
    // deleted in between (a lake teardown racing a curator). Without the guard the route would
    // answer `{ data: null }` with a 200 and the picker would render an assignment that never
    // happened.
    h.assignFinding.mockResolvedValue(null);

    await expect(invoke({ action: 'assign', assigneeUserId: 'curator-2' }).done).rejects.toThrow(/not found/i);
  });

  it.each([
    ['assign', { action: 'assign', assigneeUserId: 'curator-2' }],
    ['dismiss', { action: 'dismiss' }],
  ])("refuses ANOTHER lake's finding on the %s path too, not just resolve", async (_action, body) => {
    // The guard sits above the action branch, so every action must inherit it. Pinned per action
    // because a later refactor that moves the check inside the resolve branch would otherwise leave
    // assign and dismiss as a cross-lake hole with the suite still green.
    h.findById.mockResolvedValue({ ...existing, lakeId: 'someone-elses-lake' });

    await expect(invoke(body).done).rejects.toThrow(/not found/i);
    expect(h.assignFinding).not.toHaveBeenCalled();
    expect(h.resolveFinding).not.toHaveBeenCalled();
  });

  it('hands a non-ObjectId findingId straight to the lookup and 404s on the null', async () => {
    // The route does no id validation of its own - it relies on BaseRepository.findById returning
    // null for an uncastable id. Pinned because nothing else states that dependency: a repository
    // that let the CastError escape instead would turn a caller-supplied string into a 500, which
    // is both a worse status and a probe oracle. Asserting the raw value reaches the lookup is what
    // catches a "sanitizing" coercion being added above it.
    h.findById.mockResolvedValue(null);

    await expect(invoke({ action: 'resolve' }, 'not-an-object-id').done).rejects.toThrow(/not found/i);
    expect(h.findById).toHaveBeenCalledWith('not-an-object-id');
    expect(h.resolveFinding).not.toHaveBeenCalled();
  });
});
