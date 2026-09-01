import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  detectLakeInconsistencies: vi.fn(),
  update: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
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
const invoke = (body: Record<string, unknown> = {}) => {
  const { res, json } = makeRes();
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'POST', query: { id: 'lake1' }, body, user: { id: 'u1' }, logger: { warn: vi.fn() } },
      res
    ),
  };
};

const report = (over: Record<string, unknown> = {}) => ({
  findings: [],
  countsByKind: { 'superlative-conflict': 0, 'metric-disagreement': 0, 'relationship-conflict': 0, 'expired-claim': 0 },
  sampled: false,
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
    expect(payload.inconsistencyReport).toMatchObject({ sampled: false });
    expect(payload.inconsistencyComputedAt).toBeInstanceOf(Date);
  });

  it('passes the resolved lake document, not the route id, to the detector', async () => {
    // The route id can be a slug; the detector needs the document's own membership fields.
    const { done } = invoke();
    await done;

    expect(h.detectLakeInconsistencies.mock.calls[0][0]).toBe(lake);
    expect(typeof h.detectLakeInconsistencies.mock.calls[0][1]).toBe('number');
  });

  it('caps what it STORES while returning the same capped payload', async () => {
    // The lake document must not grow without bound. The counts stay exact either way, so a capped
    // list can never imply fewer findings than exist.
    const findings = Array.from({ length: 250 }, (_, i) => ({
      kind: 'expired-claim',
      subject: String(i),
      evidence: [{ fabFileId: `f${i}`, fileName: null, excerpt: 'x' }],
    }));
    h.detectLakeInconsistencies.mockResolvedValue(report({ findings, countsByKind: { 'expired-claim': 250 } }));

    const { json, done } = invoke();
    await done;

    expect(h.update.mock.calls[0][0].inconsistencyReport.findings).toHaveLength(200);
    expect(json.mock.calls[0][0].findings).toHaveLength(200);
    expect(json.mock.calls[0][0].countsByKind['expired-claim']).toBe(250);
  });

  it('returns the stored report with computedAt so a caller need not re-read the lake', async () => {
    const { json, done } = invoke();
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({ sampled: false, findings: [] });
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
