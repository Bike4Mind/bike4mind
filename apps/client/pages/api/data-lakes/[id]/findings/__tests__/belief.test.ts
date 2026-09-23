import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  assertDataLakeWriteScope: vi.fn(),
  findById: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'curator-1', isAdmin: false })),
  recordFindingResolutionBelief: vi.fn(async () => ({ recorded: true })),
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
  dataLakeFindingRepository: { findById: h.findById },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/recordFindingResolutionBelief', () => ({
  recordFindingResolutionBelief: h.recordFindingResolutionBelief,
}));

import handler from '../[findingId]/belief';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const lake = { id: 'lakeDoc1' };
const resolvedFinding = {
  id: 'f1',
  lakeId: 'lakeDoc1',
  status: 'resolved',
  resolution: 'different fiscal years',
};

const invoke = (findingId = 'f1') => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) };
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', query: { id: 'lake1', findingId }, body: {}, user: { id: 'curator-1' }, logger },
      res
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.findById.mockResolvedValue(resolvedFinding);
  h.recordFindingResolutionBelief.mockResolvedValue({ recorded: true });
});

describe('POST /api/data-lakes/[id]/findings/[findingId]/belief (#3049)', () => {
  it('gates on manage access and on the write scope', async () => {
    await invoke().done;

    expect(h.assertLakeWriteAccess).toHaveBeenCalledTimes(1);
    expect(h.assertDataLakeWriteScope).toHaveBeenCalledTimes(1);
  });

  it("refuses another lake's finding, so a manager cannot project a foreign ruling into their lake", async () => {
    h.findById.mockResolvedValue({ ...resolvedFinding, lakeId: 'someone-elses-lake' });

    await expect(invoke().done).rejects.toThrow(/not found/i);
    expect(h.recordFindingResolutionBelief).not.toHaveBeenCalled();
  });

  it('refuses a finding that does not exist', async () => {
    h.findById.mockResolvedValue(null);

    await expect(invoke().done).rejects.toThrow(/not found/i);
    expect(h.recordFindingResolutionBelief).not.toHaveBeenCalled();
  });

  it('refuses an OPEN finding, which has no ruling to project', async () => {
    // A bad request rather than a quiet `{ recorded: false }`: the other non-recording answers are
    // the system's state (memory is off), this one is the caller asking for something that does not
    // exist yet, and collapsing the two would have a surface report "nothing to record" for a
    // finding nobody has triaged.
    h.findById.mockResolvedValue({ ...resolvedFinding, status: 'open', resolution: null });

    await expect(invoke().done).rejects.toThrow(/not been ruled on/i);
    expect(h.recordFindingResolutionBelief).not.toHaveBeenCalled();
  });

  it('records from the STORED resolution, never from the request body', async () => {
    // The route takes no body by design: the finding row stays the single account of what the
    // curator decided, and this is only its projection into memory. A body-sourced note could say
    // something the finding does not.
    await invoke().done;

    const [params] = h.recordFindingResolutionBelief.mock.calls[0];
    expect(params.lake).toBe(lake);
    expect(params.finding).toBe(resolvedFinding);
    expect(params.status).toBe('resolved');
    expect(params.resolution).toBe('different fiscal years');
  });

  it('projects a dismissal too, carrying its own terminal status', async () => {
    h.findById.mockResolvedValue({ ...resolvedFinding, status: 'dismissed', resolution: 'not a duplicate' });

    await invoke().done;

    expect(h.recordFindingResolutionBelief.mock.calls[0][0].status).toBe('dismissed');
  });

  it('returns the refusal reason rather than an error when memory is off', async () => {
    h.recordFindingResolutionBelief.mockResolvedValue({ recorded: false, reason: 'platform-disabled' });

    const { json, done } = invoke();
    await done;

    expect(json).toHaveBeenCalledWith({ data: { recorded: false, reason: 'platform-disabled' } });
  });

  it('answers with the recorded result on success', async () => {
    const { json, done } = invoke();
    await done;

    expect(json).toHaveBeenCalledWith({ data: { recorded: true } });
  });

  it('hands a non-ObjectId findingId straight to the lookup and 404s on the null', async () => {
    h.findById.mockResolvedValue(null);

    await expect(invoke('not-an-object-id').done).rejects.toThrow(/not found/i);
    expect(h.findById).toHaveBeenCalledWith('not-an-object-id');
  });

  it('stamps the shred fence before its own I/O', async () => {
    // The instant must predate the access gate, the finding read and the settings read inside the
    // recorder - a purge landing in any of those windows has to refuse the write rather than lift
    // its own tombstone. Bracketed rather than compared to a fixed value so the assertion says the
    // thing that matters: taken on arrival, not on the way to the append.
    const before = Date.now();
    await invoke().done;
    const after = Date.now();

    const { startedAt } = h.recordFindingResolutionBelief.mock.calls[0][0];
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(startedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('PROPAGATES a recorder fault instead of swallowing it, unlike the resolve sibling', async () => {
    // The asymmetry is deliberate and worth pinning: the resolve route swallows because its ruling
    // is already committed and a 500 would report a durable write as not having happened. This route
    // commits nothing, so failing loudly costs nothing and is honest about a memory subsystem that
    // is down - and a retro-fill is safe to retry. A `catch` added here would be a silent success on
    // a belief that was never written.
    h.recordFindingResolutionBelief.mockRejectedValue(new Error('ledger unreachable'));

    await expect(invoke().done).rejects.toThrow(/ledger unreachable/i);
  });
});
