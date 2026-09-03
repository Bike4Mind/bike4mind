import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  detectLakeInconsistencies: vi.fn(),
  update: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  // The rate limiter is a middleware, so it is only reachable if the mocked chain below actually
  // RUNS what the route hands to `.use` - see that mock.
  rateLimit: vi.fn(),
  rateLimitOptions: undefined as Record<string, unknown> | undefined,
  isDevelopment: vi.fn(() => false),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    // `use` middlewares are RUN, in order, before the verb handler. The previous stub discarded them,
    // which is why the rate limit had no coverage: the route's POST-only guard was never executed.
    // Each is called with a `next` that continues the chain, so a middleware that does not call
    // `next` short-circuits here exactly as it would in production.
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
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: Record<string, unknown>) => {
    h.rateLimitOptions = options;
    return (req: unknown, res: unknown, next: () => unknown) => (h.rateLimit(), next());
  },
}));
vi.mock('@server/utils/config', () => ({ isDevelopment: h.isDevelopment }));
// Must call `next()` now that the chain above actually runs its middlewares - a no-op stub would
// short-circuit every request before the verb handler.
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeWriteAccess: h.assertLakeWriteAccess,
    detectLakeInconsistencies: h.detectLakeInconsistencies,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { update: h.update },
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  fabFileChunkRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../inconsistencies';

const lake = { id: 'lakeDoc1', datalakeTag: 'datalake:acme' };
const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) }, json };
};
const invoke = (body: Record<string, unknown> = {}, method = 'POST') => {
  const { res, json } = makeRes();
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method, query: { id: 'lake1' }, body, user: { id: 'u1' }, logger: { warn: vi.fn() } },
      res
    ),
  };
};

const report = (over: Record<string, unknown> = {}) => ({
  findings: [],
  countsByKind: { 'superlative-conflict': 0, 'metric-disagreement': 0, 'relationship-conflict': 0, 'expired-claim': 0 },
  sampled: true,
  truncated: false,
  memberSampled: false,
  memberCount: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.detectLakeInconsistencies.mockResolvedValue(report());
  h.update.mockResolvedValue(lake);
});

describe('POST /api/data-lakes/[id]/inconsistencies (#2242)', () => {
  it('gates on WRITE access, not read access - the response carries document excerpts', async () => {
    // A reader who can see a lake is not necessarily entitled to read every member's prose. This is
    // also what refuses fallback lakes, which have no document to store a report on.
    const { done } = invoke();
    await done;

    expect(h.assertLakeWriteAccess).toHaveBeenCalledTimes(1);
    expect(h.assertLakeWriteAccess.mock.calls[0][0]).toBe('lake1');
  });

  it('persists the report and its timestamp on the lake', async () => {
    // Storing is the point: health may not scan chunks, so it renders what this wrote.
    const { done } = invoke();
    await done;

    expect(h.update).toHaveBeenCalledTimes(1);
    const payload = h.update.mock.calls[0][0];
    expect(payload.id).toBe('lakeDoc1');
    expect(payload.inconsistencyReport).toMatchObject({ sampled: true });
    expect(payload.inconsistencyComputedAt).toBeInstanceOf(Date);
  });

  it('passes the resolved lake document, not the route id, to the detector', async () => {
    // The route id can be a slug; the detector needs the document's own membership fields.
    const { done } = invoke();
    await done;

    expect(h.detectLakeInconsistencies.mock.calls[0][0]).toBe(lake);
    expect(typeof h.detectLakeInconsistencies.mock.calls[0][1]).toBe('number');
  });

  it('stores what the detector returned without re-capping it', async () => {
    // The cap lives in the detector, which allocates it PER KIND. A slice here would re-create the
    // starvation that allocation exists to prevent: findings sort by kind name, so one prolific kind
    // would take the whole budget again and evict the cross-document findings the feature is for.
    const findings = Array.from({ length: 200 }, (_, i) => ({
      kind: i < 100 ? 'expired-claim' : 'metric-disagreement',
      subject: String(i),
      evidence: [{ fabFileId: `f${i}`, fileName: null, excerpt: 'x' }],
      documentCount: 2,
    }));
    h.detectLakeInconsistencies.mockResolvedValue(
      report({ findings, truncated: true, countsByKind: { 'expired-claim': 250, 'metric-disagreement': 100 } })
    );

    const { json, done } = invoke();
    await done;

    const stored = h.update.mock.calls[0][0].inconsistencyReport;
    expect(stored.findings).toHaveLength(200);
    expect(new Set(stored.findings.map((f: { kind: string }) => f.kind))).toEqual(
      new Set(['expired-claim', 'metric-disagreement'])
    );
    // The counts stay exact, so a capped list can never imply fewer findings than exist.
    expect(json.mock.calls[0][0].countsByKind['expired-claim']).toBe(250);
    expect(json.mock.calls[0][0].truncated).toBe(true);
  });

  it('returns the stored report with computedAt so a caller need not re-read the lake', async () => {
    const { json, done } = invoke();
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({ sampled: true, findings: [] });
    expect(json.mock.calls[0][0].computedAt).toBeInstanceOf(Date);
  });

  it('does not persist anything when the access gate refuses', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('not found'));

    const { done } = invoke();
    await expect(done).rejects.toThrow('not found');

    expect(h.detectLakeInconsistencies).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/data-lakes/[id]/inconsistencies', () => {
  it('returns the stored report and runs no detection', async () => {
    // Without a GET every look was a write: re-reading findings meant re-POSTing, which re-scans the
    // corpus, overwrites the report and stamps a new computedAt - destroying the run-to-run
    // comparability nowYear is injected to preserve.
    const stored = report({ memberCount: 12 });
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: stored,
      inconsistencyComputedAt: new Date('2026-06-01T00:00:00Z'),
    });

    const { json, done } = invoke({}, 'GET');
    await done;

    expect(h.detectLakeInconsistencies).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0]).toMatchObject({ memberCount: 12, computedAt: new Date('2026-06-01T00:00:00Z') });
  });

  it('returns null when detection has never run, rather than an empty report', async () => {
    // "Never asked" and "asked and found nothing" are different answers.
    const { json, done } = invoke({}, 'GET');
    await done;

    expect(json.mock.calls[0][0]).toBeNull();
  });

  it('is manage-gated too, because the payload carries document excerpts either way', async () => {
    // It is the PROSE that decides the gate here, not the mutation. The read-gated view of this data
    // is the counts-only summary on GET /health.
    h.assertLakeWriteAccess.mockRejectedValue(new Error('forbidden'));

    const { done } = invoke({}, 'GET');
    await expect(done).rejects.toThrow('forbidden');
  });
});

describe('POST /api/data-lakes/:id/inconsistencies rate limit', () => {
  it('buckets per CALLER rather than per lake', () => {
    // The load-bearing detail, and the reason the bucket is explicit. Without it the middleware keys
    // on `req.url`, which carries the lake id - so the cap would be per lake per caller and "loop
    // over every lake I own" would stay unbounded, the amplification converge already closed.
    expect(h.rateLimitOptions?.bucket).toBe('data-lakes/inconsistencies');
  });

  it('caps detection at 20 runs an hour outside development', () => {
    const limit = h.rateLimitOptions?.limit as () => number;

    expect(h.rateLimitOptions?.windowMs).toBe(60 * 60 * 1000);
    expect(limit()).toBe(20);
  });

  it('lifts the cap in development', () => {
    h.isDevelopment.mockReturnValueOnce(true);
    const limit = h.rateLimitOptions?.limit as () => number;

    expect(limit()).toBe(Infinity);
  });

  it('applies the limit to POST', async () => {
    const { done } = invoke({});
    await done;

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
  });

  it('leaves GET outside the cap, so looking at a report is never throttled', async () => {
    // GET reads what was already stored and runs no detection. Throttling it would throttle looking
    // at a report rather than producing one - and re-reading is the whole reason GET exists.
    h.assertLakeWriteAccess.mockResolvedValue({ ...lake, inconsistencyReport: report() });

    const { done } = invoke({}, 'GET');
    await done;

    expect(h.rateLimit).not.toHaveBeenCalled();
  });
});
