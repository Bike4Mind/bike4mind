import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  detectLakeInconsistencies: vi.fn(),
  detectLakeInconsistenciesModel: vi.fn(),
  recordLakeFindings: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  update: vi.fn(),
  recordDetected: vi.fn(),
  listByLake: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  // The rate limiter is a middleware, so it is only reachable if the mocked chain below actually
  // RUNS what the route hands to `.use` - see that mock. Model detection uses its own bucket, so
  // calls are recorded per-bucket rather than in one shared counter.
  rateLimit: vi.fn(),
  rateLimitCallsByBucket: {} as Record<string, number>,
  rateLimitOptionsByBucket: {} as Record<string, Record<string, unknown>>,
  isDevelopment: vi.fn(() => false),
  // Configurable per test: settings this set blocks with a 403, matching requireFeatureEnabled's
  // real shape - lets the model-only gate be exercised without disabling EnableDataLakes too.
  blockedFeatureKeys: new Set<string>(),
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
    const bucket = options.bucket as string;
    h.rateLimitOptionsByBucket[bucket] = options;
    return (req: unknown, res: unknown, next: () => unknown) => (
      (h.rateLimitCallsByBucket[bucket] = (h.rateLimitCallsByBucket[bucket] ?? 0) + 1),
      h.rateLimit(),
      next()
    );
  },
}));
vi.mock('@server/utils/config', () => ({ isDevelopment: h.isDevelopment }));
// Configurable so the model-only feature gate (EnableLakeModelInconsistencyDetection) can be tested
// without also disabling EnableDataLakes, which every request passes through first.
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled:
    (key: string) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => unknown) =>
      h.blockedFeatureKeys.has(key) ? res.status(403).json({ error: 'forbidden' }) : next(),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeWriteAccess: h.assertLakeWriteAccess,
    detectLakeInconsistencies: h.detectLakeInconsistencies,
    detectLakeInconsistenciesModel: h.detectLakeInconsistenciesModel,
    recordLakeFindings: h.recordLakeFindings,
    INCONSISTENCY_FINDINGS_CAP: 200,
    INCONSISTENCY_DETECTOR: 'lexical',
  },
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { update: h.update },
  dataLakeAccessGrantRepository: {},
  dataLakeFindingRepository: { recordDetected: h.recordDetected, listByLake: h.listByLake },
  fabFileRepository: {},
  fabFileChunkRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../inconsistencies';

const lake = { id: 'lakeDoc1', datalakeTag: 'datalake:acme' };
const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) }, json };
};
const invoke = (body: Record<string, unknown> = {}, method = 'POST', query: Record<string, unknown> = {}) => {
  const { res, json } = makeRes();
  return {
    json,
    done: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      {
        method,
        query: { id: 'lake1', ...query },
        body,
        user: { id: 'u1' },
        logger: { warn: h.loggerWarn, error: h.loggerError },
      },
      res
    ),
  };
};

/** The detector's result envelope: the stored report plus the dismissals it kept out of it. */
const result = (over: Record<string, unknown> = {}, suppressed: unknown[] = []) => ({
  report: report(over),
  suppressed,
});

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
  // Plain objects/Sets, not vi.fn() - clearAllMocks does not touch these, so each test starts clean.
  h.rateLimitCallsByBucket = {};
  h.blockedFeatureKeys = new Set();
  h.assertLakeWriteAccess.mockResolvedValue(lake);
  h.detectLakeInconsistencies.mockResolvedValue(result());
  h.detectLakeInconsistenciesModel.mockResolvedValue({
    findings: [],
    memberCount: 0,
    memberSampled: false,
    batchesRun: 0,
    batchesFailed: 0,
    truncated: false,
  });
  h.getEffectiveLLMApiKeys.mockResolvedValue({});
  h.update.mockResolvedValue(lake);
  h.recordLakeFindings.mockResolvedValue({ recorded: 0, failed: 0 });
  h.listByLake.mockResolvedValue([]);
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

  it('persists the run SUMMARY and its timestamp on the lake, never the findings', async () => {
    // Storing is the point: health may not scan chunks, so it renders what this wrote. But only the
    // run-level half - the findings are rows, and a copy here would be an unkeyed duplicate of every
    // one of them plus a document excerpt nothing can ever sweep.
    h.detectLakeInconsistencies.mockResolvedValue(
      result({ findings: [{ kind: 'expired-claim', subject: 's', evidence: [], documentCount: 2 }] })
    );

    const { done } = invoke();
    await done;

    expect(h.update).toHaveBeenCalledTimes(1);
    const payload = h.update.mock.calls[0][0];
    expect(payload.id).toBe('lakeDoc1');
    expect(payload.inconsistencyReport).toMatchObject({ sampled: true });
    expect(payload.inconsistencyReport).not.toHaveProperty('findings');
    expect(payload.inconsistencyComputedAt).toBeInstanceOf(Date);
  });

  it('passes the resolved lake document, not the route id, to the detector', async () => {
    // The route id can be a slug; the detector needs the document's own membership fields.
    const { done } = invoke();
    await done;

    expect(h.detectLakeInconsistencies.mock.calls[0][0]).toBe(lake);
    expect(typeof h.detectLakeInconsistencies.mock.calls[0][1]).toBe('number');
    // Without this adapter the detector has no way to see what a curator dismissed, and every run
    // re-reports it (#3045).
    expect(h.detectLakeInconsistencies.mock.calls[0][2].db.dataLakeFindings).toBeDefined();
  });

  it('stores what the detector returned without re-capping it', async () => {
    // The cap lives in the detector, which allocates it PER KIND. A slice here would re-create the
    // starvation that allocation exists to prevent: findings sort by kind name, so one prolific kind
    // would take the whole budget again and evict the cross-document findings the feature is for.
    // Deliberately LONGER than INCONSISTENCY_FINDINGS_CAP (200). At exactly the cap a route-level
    // `.slice(0, CAP)` returns the same 200 findings and this test passes with the regression
    // present - which is the whole thing it is named for.
    const findings = Array.from({ length: 260 }, (_, i) => ({
      kind: i < 130 ? 'expired-claim' : 'metric-disagreement',
      subject: String(i),
      evidence: [{ fabFileId: `f${i}`, fileName: null, excerpt: 'x' }],
      documentCount: 2,
    }));
    h.detectLakeInconsistencies.mockResolvedValue(
      result({ findings, truncated: true, countsByKind: { 'expired-claim': 250, 'metric-disagreement': 100 } })
    );

    const { json, done } = invoke();
    await done;

    // Asserted on what the route EMITTED rather than what it stored: the findings are rows now, so
    // the run's own list reaches the caller and the findings repository, not the lake document.
    const emitted = h.recordLakeFindings.mock.calls[0][1];
    expect(emitted).toHaveLength(260);
    expect(new Set(emitted.map((f: { kind: string }) => f.kind))).toEqual(
      new Set(['expired-claim', 'metric-disagreement'])
    );
    // The RESPONSE's findings now come from the rows (same shape GET serves), so what it pins here
    // is only that nothing re-capped what went to the write door.
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

  it('reads the findings from the ROWS, bounded and open-or-resolved, not from the lake document', async () => {
    // The stored summary carries no findings at all any more. `countsByKind` is an exact total over
    // every finding the run reported, with no notion of a curator's status, so `open` alone could
    // list fewer findings than the count beside them describes - see the docblock on
    // `renderStoredReport`. `resolved` is included for that reason; `dismissed` never is, since a
    // dismissed subject is dropped before the run counts it at all.
    const row = { id: 'finding-1', kind: 'expired-claim', subject: 'roadmap', status: 'open' };
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: report({ memberCount: 3 }),
      inconsistencyComputedAt: new Date('2026-06-01T00:00:00Z'),
    });
    h.listByLake.mockResolvedValue([row]);

    const { json, done } = invoke({}, 'GET');
    await done;

    expect(h.listByLake).toHaveBeenCalledWith('lakeDoc1', {
      status: ['open', 'resolved'],
      seenSince: new Date('2026-06-01T00:00:00Z'),
      limit: 200,
    });
    expect(json.mock.calls[0][0]).toMatchObject({ memberCount: 3, findings: [row] });
  });

  it('selects findings by the stored run date, so counts never sit beside findings they exclude', async () => {
    // Nothing closes a finding the detector stops reporting - deliberately, since `status` is a
    // curator's word. So a fixed problem leaves an `open` row behind forever, and listing every
    // open row beside this run's `countsByKind` would ship counts of zero next to findings they do
    // not count. The daily sweep would make that gap permanent rather than transient.
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: report(),
      inconsistencyComputedAt: new Date('2026-07-01T00:00:00Z'),
    });

    const { done } = invoke({}, 'GET');
    await done;

    expect(h.listByLake.mock.calls[0][1].seenSince).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  it('does not read findings for a lake detection never ran against', async () => {
    // A null summary is the "never asked" answer; querying rows first would spend a read to
    // discover the same thing.
    const { done } = invoke({}, 'GET');
    await done;

    expect(h.listByLake).not.toHaveBeenCalled();
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

  it('subtracts a dismissal made after the run from countsByKind, so the served count matches the served findings', async () => {
    // `resolveFinding` never recomputes the stored summary - a dismissal only ever touches the row.
    // Serving the stored count as-is would show a non-zero count beside a findings list that no
    // longer contains that subject, the identical shape `seenSince` was added to close.
    const computedAt = new Date('2026-06-01T00:00:00Z');
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: report({ countsByKind: { ...report().countsByKind, 'expired-claim': 1 } }),
      inconsistencyComputedAt: computedAt,
    });
    h.listByLake.mockImplementation(async (_id: string, opts: { status?: string | string[] }) =>
      opts.status === 'dismissed' ? [{ id: 'finding-1', kind: 'expired-claim', subject: 'roadmap' }] : []
    );

    const { json, done } = invoke({}, 'GET');
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({
      countsByKind: { 'expired-claim': 0 },
      findings: [],
    });
    // seenSince AND resolvedSince together, not either alone - resolvedSince alone would also match
    // a row this run never re-detected (its lastSeenAt is from an older run), and seenSince alone
    // would also match a subject dismissed before this run but re-detected by it.
    const dismissedCall = h.listByLake.mock.calls.find(call => call[1].status === 'dismissed');
    expect(dismissedCall?.[1]).toMatchObject({ seenSince: computedAt, resolvedSince: computedAt });
  });

  it('does not subtract a dismissal that predates this run, even if the row was re-detected by it', async () => {
    // The query itself is the guard: a dismissal dated before `computedAt` cannot match
    // `resolvedSince: computedAt` regardless of how recently the row's lastSeenAt advanced. This
    // pins that the route asks for the right field rather than merely happening to pass one named
    // `resolvedSince` - a kind with a genuinely counted, un-dismissed subject must not move.
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: report({ countsByKind: { ...report().countsByKind, 'expired-claim': 1 } }),
      inconsistencyComputedAt: new Date('2026-06-01T00:00:00Z'),
    });
    // A real repository would exclude this row given `resolvedSince`, since it was resolved before
    // the run; asserting the route never widens that contract to a `seenSince`-only lookup that a
    // pre-run dismissal, re-detected, would also satisfy.
    h.listByLake.mockResolvedValue([]);

    const { json, done } = invoke({}, 'GET');
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({ countsByKind: { 'expired-claim': 1 } });
  });

  it('never drives a count below zero for a kind that was already exhausted', async () => {
    h.assertLakeWriteAccess.mockResolvedValue({
      ...lake,
      inconsistencyReport: report(),
      inconsistencyComputedAt: new Date('2026-06-01T00:00:00Z'),
    });
    h.listByLake.mockImplementation(async (_id: string, opts: { status?: string | string[] }) =>
      opts.status === 'dismissed' ? [{ id: 'finding-1', kind: 'expired-claim', subject: 'roadmap' }] : []
    );

    const { json, done } = invoke({}, 'GET');
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({ countsByKind: { 'expired-claim': 0 } });
  });
});

describe('POST /api/data-lakes/:id/inconsistencies rate limit', () => {
  it('buckets per CALLER rather than per lake', () => {
    // The load-bearing detail, and the reason the bucket is explicit. Without it the middleware keys
    // on `req.url`, which carries the lake id - so the cap would be per lake per caller and "loop
    // over every lake I own" would stay unbounded, the amplification converge already closed.
    expect(h.rateLimitOptionsByBucket['data-lakes/inconsistencies']?.bucket).toBe('data-lakes/inconsistencies');
  });

  it('caps detection at 20 runs an hour outside development', () => {
    const options = h.rateLimitOptionsByBucket['data-lakes/inconsistencies'];
    const limit = options?.limit as () => number;

    expect(options?.windowMs).toBe(60 * 60 * 1000);
    expect(limit()).toBe(20);
  });

  it('lifts the cap in development', () => {
    h.isDevelopment.mockReturnValueOnce(true);
    const limit = h.rateLimitOptionsByBucket['data-lakes/inconsistencies']?.limit as () => number;

    expect(limit()).toBe(Infinity);
  });

  it('applies the limit to POST', async () => {
    const { done } = invoke({});
    await done;

    expect(h.rateLimitCallsByBucket['data-lakes/inconsistencies']).toBe(1);
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

describe('POST /api/data-lakes/[id]/inconsistencies?detector=model (#3057)', () => {
  it('is gated behind EnableLakeModelInconsistencyDetection, unlike the lexical branch', async () => {
    h.blockedFeatureKeys.add('EnableLakeModelInconsistencyDetection');

    const { done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(h.detectLakeInconsistenciesModel).not.toHaveBeenCalled();
    // The feature gate sits AHEAD of the rate limiter, so a disabled-feature caller never burns its
    // (far lower) hourly budget on a request that was always going to 403.
    expect(h.rateLimitCallsByBucket['data-lakes/inconsistencies/model']).toBeUndefined();
  });

  it('does not gate the lexical branch behind the model-only flag', async () => {
    h.blockedFeatureKeys.add('EnableLakeModelInconsistencyDetection');

    const { done } = invoke({});
    await done;

    expect(h.detectLakeInconsistencies).toHaveBeenCalledTimes(1);
  });

  it('buckets rate limiting separately from the lexical run, at its own lower cap', async () => {
    const { done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(h.rateLimitCallsByBucket['data-lakes/inconsistencies/model']).toBe(1);
    expect(h.rateLimitCallsByBucket['data-lakes/inconsistencies']).toBeUndefined();
    const options = h.rateLimitOptionsByBucket['data-lakes/inconsistencies/model'];
    const limit = options?.limit as () => number;
    expect(limit()).toBe(3);
  });

  it('resolves the LAKE OWNER api keys, not the caller, matching extractLakeMemoryForBatch attribution', async () => {
    const ownedLake = { ...lake, createdByUserId: 'owner1' };
    h.assertLakeWriteAccess.mockResolvedValue(ownedLake);

    const { done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(h.getEffectiveLLMApiKeys.mock.calls[0][0]).toBe('owner1');
  });

  it('runs the model detector and returns its result with a computedAt, leaving the lexical blob untouched', async () => {
    const findings = [{ kind: 'narrative-contradiction', subject: 'refund window', evidence: [], documentCount: 2 }];
    h.detectLakeInconsistenciesModel.mockResolvedValue({
      findings,
      memberCount: 2,
      memberSampled: false,
      batchesRun: 1,
      batchesFailed: 0,
      truncated: false,
    });

    const { json, done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(h.detectLakeInconsistencies).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0]).toMatchObject({ findings, memberCount: 2 });
    expect(json.mock.calls[0][0].computedAt).toBeInstanceOf(Date);
  });

  it('records the model findings under detector "model", separately from the lexical rows', async () => {
    const findings = [{ kind: 'narrative-contradiction', subject: 'refund window', evidence: [], documentCount: 2 }];
    h.detectLakeInconsistenciesModel.mockResolvedValue({
      findings,
      memberCount: 2,
      memberSampled: false,
      batchesRun: 1,
      batchesFailed: 0,
      truncated: false,
    });

    const { done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(h.recordLakeFindings).toHaveBeenCalledTimes(1);
    const [lakeId, passed, options] = h.recordLakeFindings.mock.calls[0];
    expect(lakeId).toBe('lakeDoc1');
    expect(passed).toBe(findings);
    expect(options.detector).toBe('model');
  });

  it('still returns the run result when the findings write fails outright', async () => {
    const findings = [{ kind: 'narrative-contradiction', subject: 'refund window', evidence: [], documentCount: 2 }];
    h.detectLakeInconsistenciesModel.mockResolvedValue({
      findings,
      memberCount: 2,
      memberSampled: false,
      batchesRun: 1,
      batchesFailed: 0,
      truncated: false,
    });
    h.recordLakeFindings.mockRejectedValue(new Error('findings collection unavailable'));

    const { json, done } = invoke({}, 'POST', { detector: 'model' });
    await done;

    expect(json.mock.calls[0][0]).toMatchObject({ findings });
    expect(h.loggerWarn).toHaveBeenCalledWith(
      'Model lake findings partially recorded',
      expect.objectContaining({ failed: findings.length })
    );
  });
});

describe('POST /api/data-lakes/[id]/inconsistencies -> durable findings (#3039)', () => {
  const findings = [
    { kind: 'metric-disagreement', subject: 'annual revenue usd', evidence: [], documentCount: 2 },
    { kind: 'expired-claim', subject: 'current roadmap', evidence: [], documentCount: 3 },
  ];

  it('emits every finding the run produced as a durable row', async () => {
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));

    const { done } = invoke();
    await done;

    expect(h.recordLakeFindings).toHaveBeenCalledTimes(1);
    const [lakeId, passed, options] = h.recordLakeFindings.mock.calls[0];
    expect(lakeId).toBe('lakeDoc1');
    expect(passed).toEqual(findings);
    expect(options.detector).toBe('lexical');
  });

  it('records what a dismissal suppressed, so the row behind it does not freeze', async () => {
    // Suppressed from the REPORT, current in the ROW. A dismissal keys on kind and subject, so the
    // evidence under one can change into a worse contradiction with the row as its only trace.
    const dismissedFinding = {
      kind: 'superlative-conflict',
      subject: 'crm',
      evidence: [],
      documentCount: 2,
    };
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }, [dismissedFinding]));

    const { done } = invoke();
    await done;

    const [, passed] = h.recordLakeFindings.mock.calls[0];
    expect(passed).toEqual([...findings, dismissedFinding]);
    // ...and never into the summary, which carries no findings at all any more.
    expect(h.update.mock.calls[0][0].inconsistencyReport).not.toHaveProperty('findings');
  });

  it('stamps the rows with the SAME instant it stamped the report', async () => {
    // A run's rows and its report have to agree on one instant. Were the clock read twice they would
    // drift by the write latency, and nothing downstream could line a report up with its findings.
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));

    const { done } = invoke();
    await done;

    const computedAt = h.update.mock.calls[0][0].inconsistencyComputedAt;
    expect(h.recordLakeFindings.mock.calls[0][2].seenAt).toBe(computedAt);
  });

  it('writes the rows BEFORE dating the summary, so a summary never outruns its findings', async () => {
    // The inverse of the order this ran in while the rows were additive behind the blob. Now the
    // rows ARE the record, and `inconsistencyComputedAt` is what a surface reads as "detection
    // ran" - so a dated summary standing over findings that were never written is the misleading
    // half.
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));
    const order: string[] = [];
    h.update.mockImplementation(async () => void order.push('summary'));
    h.recordLakeFindings.mockImplementation(async () => (order.push('findings'), { recorded: 2, failed: 0 }));

    const { done } = invoke();
    await done;

    expect(order).toEqual(['findings', 'summary']);
  });

  it('dates no summary, and does not 200, when findings went unwritten', async () => {
    // The failure mode that actually occurs. `recordLakeFindings` isolates per-finding failures
    // into `failed` and NEVER throws - not even for an unavailable collection - so reordering the
    // two writes is not on its own a guard: without an explicit gate the handler sails past N
    // failures and stamps a fresh computedAt and a full countsByKind over zero persisted rows.
    // Since GET selects findings by that date, the result is counts with no findings beside them.
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));
    h.recordLakeFindings.mockResolvedValue({ recorded: 0, failed: 2 });

    const { done } = invoke();
    await expect(done).rejects.toThrow(/Recorded 0 of 2 findings/);

    expect(h.update).not.toHaveBeenCalled();
    expect(h.loggerWarn).toHaveBeenCalledWith(
      'Lake findings partially recorded; summary not stored',
      expect.objectContaining({ failed: 2, total: 2 })
    );
  });

  it('does not store a summary for a run that recorded only some of its findings', async () => {
    // Partial is not a lesser kind of success here: `countsByKind` is exact and unfiltered, so a
    // summary dated over a subset of rows overstates what a curator can actually open. Retrying is
    // safe - recordDetected is an idempotent upsert - and the last COMPLETE run's summary stays
    // correctly dated meanwhile.
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));
    h.recordLakeFindings.mockResolvedValue({ recorded: 1, failed: 1 });

    const { done } = invoke();
    await expect(done).rejects.toThrow(/Recorded 1 of 2 findings/);

    expect(h.update).not.toHaveBeenCalled();
  });

  it('returns the same shape as GET, so a surface can render both', async () => {
    // Returning the detector's in-memory findings here would hand a caller rows with no id, no
    // status and `evidence` where the persisted row has `sources` - so "run it now" could not be
    // rendered by the same component as "show me the last run", and nothing it just found could be
    // resolved or assigned without a refetch.
    const row = { id: 'finding-9', kind: 'expired-claim', subject: 'roadmap', status: 'open', sources: [] };
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));
    h.recordLakeFindings.mockResolvedValue({ recorded: 2, failed: 0 });
    h.listByLake.mockResolvedValue([row]);

    const { json, done } = invoke();
    await done;

    expect(json.mock.calls[0][0].findings).toEqual([row]);
    // Selected against the summary this very run just stored, not a stale one.
    const { seenSince } = h.listByLake.mock.calls[0][1];
    expect(seenSince).toBe(h.update.mock.calls[0][0].inconsistencyComputedAt);
  });

  it('stays quiet when every finding was recorded', async () => {
    h.detectLakeInconsistencies.mockResolvedValue(result({ findings }));
    h.recordLakeFindings.mockResolvedValue({ recorded: 2, failed: 0 });

    const { done } = invoke();
    await done;

    expect(h.loggerWarn).not.toHaveBeenCalled();
  });

  it('records nothing on GET, which runs no detection', async () => {
    h.assertLakeWriteAccess.mockResolvedValue({ ...lake, inconsistencyReport: report() });

    const { done } = invoke({}, 'GET');
    await done;

    expect(h.recordLakeFindings).not.toHaveBeenCalled();
  });
});
