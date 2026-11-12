import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Partial<Record<'get' | 'post', Handler>>>,
  options: {} as Record<string, unknown>,
  current: '',
  rateLimit: vi.fn(),
  repo: { list: vi.fn(), findById: vi.fn(), addExampleVerdict: vi.fn() },
  drawEvalSet: vi.fn(),
  runEvalSet: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    const route = h.current;
    h.options[route] = options;
    h.handlers[route] = {};
    const chain = {
      use: () => chain,
      get: (...fns: Handler[]) => {
        h.handlers[route].get = fns[fns.length - 1];
        return chain;
      },
      post: (...fns: Handler[]) => {
        h.handlers[route].post = fns[fns.length - 1];
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    h.rateLimit(options);
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@bike4mind/database', () => ({ abuseEvalSetRepository: h.repo }));
vi.mock('@server/security/verdictEval/evalSets', () => ({
  drawEvalSet: h.drawEvalSet,
  runEvalSet: h.runEvalSet,
}));

const SET_ID = 'a'.repeat(24);
const USER_ID = 'b'.repeat(24);
const REVIEWER = 'c'.repeat(24);
const WHEN = new Date('2026-11-06T12:00:00.000Z');

const summary = {
  id: SET_ID,
  name: 'November',
  note: null,
  createdBy: REVIEWER,
  window: { since: WHEN, until: WHEN },
  heldOutShare: 0.5,
  population: { flagged: 2, unflagged: 10 },
  truncated: false,
  examples: 4,
  heldOutExamples: 2,
  unflaggedExamples: 2,
  labelledByVerdict: {
    confirmed_abuse: 1,
    legitimate_human: 0,
    legitimate_automation: 0,
    insufficient_evidence: 0,
  },
  runs: 0,
  lastRunAt: null,
  createdAt: WHEN,
};
const item = {
  ...summary,
  seed: 'secret-seed',
  examples: [
    {
      userId: USER_ID,
      kind: 'unflagged' as const,
      detectionIds: [],
      campaignKey: USER_ID,
      split: 'heldOut' as const,
      cohorts: ['mobile'],
      signedUpAt: WHEN,
      frozenLabel: null,
      verdicts: [],
      revision: 0,
    },
  ],
  runs: [],
  updatedAt: WHEN,
};

const load = async (route: string, module: string) => {
  h.current = route;
  await import(/* @vite-ignore */ module);
  return h.handlers[route];
};

const reqFor = (init: Parameters<typeof createMocks>[0]) => {
  const { req, res } = createMocks(init);
  (req as unknown as { user: { id: string } }).user = { id: REVIEWER };
  (req as unknown as { logger: { error: () => void } }).logger = { error: vi.fn() };
  return { req, res };
};

beforeEach(() => {
  vi.resetModules();
  Object.values(h.repo).forEach(fn => fn.mockReset());
  h.drawEvalSet.mockReset();
  h.runEvalSet.mockReset();
  h.audit.mockReset().mockResolvedValue(null);
  h.rateLimit.mockReset();
});

describe('eval-sets index', () => {
  const loadIndex = () => load('index', '@pages/api/admin/shadow-detections/eval-sets/index');

  it('lists on support:read and creates on users:moderate, rate limiting the create', async () => {
    await loadIndex();
    expect(h.options.index).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
    });
    expect(h.rateLimit).toHaveBeenCalledWith({ limit: 3, windowMs: 60_000, bucket: 'admin-eval-set-create' });
  });

  it('lists uncached', async () => {
    const { get } = await loadIndex();
    h.repo.list.mockResolvedValue([summary]);
    const { req, res } = reqFor({ method: 'GET' });
    await get!(req, res);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(res._getData()).data[0]).toMatchObject({ id: SET_ID, name: 'November' });
  });

  it('draws a set with defaults, audits it and answers 201', async () => {
    const { post } = await loadIndex();
    h.drawEvalSet.mockResolvedValue(SET_ID);
    const { req, res } = reqFor({ method: 'POST', body: { name: ' November ', days: 30 } });
    await post!(req, res);
    expect(h.drawEvalSet).toHaveBeenCalledWith(
      { name: 'November', days: 30, unflaggedSample: 200, heldOutShare: 0.5 },
      REVIEWER
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'abuse.eval_set.created' })
    );
    expect(res._getStatusCode()).toBe(201);
    expect(JSON.parse(res._getData())).toEqual({ id: SET_ID });
  });

  it.each([
    { name: '', days: 30 },
    { name: 'x', days: 14 },
    { name: 'x', days: 30, unflaggedSample: 5 },
    { name: 'x', days: 30, heldOutShare: 0.9 },
  ])('rejects %j', async body => {
    const { post } = await loadIndex();
    const { req, res } = reqFor({ method: 'POST', body });
    await expect(post!(req, res)).rejects.toThrow('Expected a name');
    expect(h.drawEvalSet).not.toHaveBeenCalled();
  });

  it('still answers when the audit write fails', async () => {
    const { post } = await loadIndex();
    h.drawEvalSet.mockResolvedValue(SET_ID);
    h.audit.mockRejectedValue(new Error('audit down'));
    const { req, res } = reqFor({ method: 'POST', body: { name: 'x', days: 7 } });
    await post!(req, res);
    expect(res._getStatusCode()).toBe(201);
  });
});

describe('eval-sets [id]', () => {
  const loadDetail = () => load('detail', '@pages/api/admin/shadow-detections/eval-sets/[id]');

  it('is read-only on support:read', async () => {
    await loadDetail();
    expect(h.options.detail).toMatchObject({ adminPermissions: { GET: 'support:read' } });
  });

  it('returns the set with labels and without its seed', async () => {
    const { get } = await loadDetail();
    h.repo.findById.mockResolvedValue(item);
    const { req, res } = reqFor({ method: 'GET', query: { id: SET_ID } });
    await get!(req, res);
    const body = JSON.parse(res._getData());
    expect(body.seed).toBeUndefined();
    expect(body.examples[0]).toMatchObject({ userId: USER_ID, currentLabel: null, revision: 0, cohorts: ['mobile'] });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('is a 404 for an unknown or malformed id', async () => {
    const { get } = await loadDetail();
    h.repo.findById.mockResolvedValue(null);
    const { req, res } = reqFor({ method: 'GET', query: { id: 'nope' } });
    await expect(get!(req, res)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('eval-sets [id]/verdict', () => {
  const body = { userId: USER_ID, verdict: 'confirmed_abuse', reason: 'farm accounts', expectedRevision: 0 };
  const loadVerdict = () => load('verdict', '@pages/api/admin/shadow-detections/eval-sets/[id]/verdict');

  it('needs users:moderate', async () => {
    await loadVerdict();
    expect(h.options.verdict).toMatchObject({ adminPermissions: { POST: 'users:moderate' } });
  });

  it('appends the verdict as the reviewer and audits it', async () => {
    const { post } = await loadVerdict();
    h.repo.addExampleVerdict.mockResolvedValue('updated');
    const { req, res } = reqFor({ method: 'POST', query: { id: SET_ID }, body });
    await post!(req, res);
    expect(h.repo.addExampleVerdict).toHaveBeenCalledWith({
      setId: SET_ID,
      userId: USER_ID,
      expectedRevision: 0,
      verdict: 'confirmed_abuse',
      reason: 'farm accounts',
      reviewerId: REVIEWER,
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'abuse.eval_set.verdict_recorded', reason: 'farm accounts' })
    );
    expect(JSON.parse(res._getData())).toEqual({ ok: true });
  });

  it('answers 409 on a stale revision and 404 on a missing example, without auditing', async () => {
    const { post } = await loadVerdict();
    h.repo.addExampleVerdict.mockResolvedValueOnce('conflict').mockResolvedValueOnce('not_found');
    const first = reqFor({ method: 'POST', query: { id: SET_ID }, body });
    await expect(post!(first.req, first.res)).rejects.toMatchObject({ statusCode: 409 });
    const second = reqFor({ method: 'POST', query: { id: SET_ID }, body });
    await expect(post!(second.req, second.res)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('answers 409 when the example has reached its verdict cap, without auditing', async () => {
    const { post } = await loadVerdict();
    h.repo.addExampleVerdict.mockResolvedValue('limit_reached');
    const { req, res } = reqFor({ method: 'POST', query: { id: SET_ID }, body });
    await expect(post!(req, res)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This example already has the maximum number of verdicts.',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('rejects a reason shorter than the shared admin reason rule', async () => {
    const { post } = await loadVerdict();
    const { req, res } = reqFor({ method: 'POST', query: { id: SET_ID }, body: { ...body, reason: 'farm' } });
    await expect(post!(req, res)).rejects.toThrow('at least 5 characters');
    expect(h.repo.addExampleVerdict).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, userId: 'x' },
    { ...body, verdict: 'maybe' },
    { ...body, expectedRevision: -1 },
  ])('rejects %j', async invalid => {
    const { post } = await loadVerdict();
    const { req, res } = reqFor({ method: 'POST', query: { id: SET_ID }, body: invalid });
    await expect(post!(req, res)).rejects.toThrow('Expected an account id');
    expect(h.repo.addExampleVerdict).not.toHaveBeenCalled();
  });
});

describe('eval-sets [id]/runs', () => {
  const loadRuns = () => load('runs', '@pages/api/admin/shadow-detections/eval-sets/[id]/runs');
  const report = {
    split: 'heldOut',
    examples: 2,
    labelled: 1,
    scores: [],
    recall: {
      flaggedExamples: 0,
      flaggedReviewed: 0,
      flaggedAbuse: 0,
      flaggedPopulation: 0,
      unflaggedExamples: 0,
      unflaggedReviewed: 0,
      unflaggedAbuse: 0,
      unflaggedPopulation: 0,
      minimumReviewed: 30,
      estimatedFlaggedAbuse: null,
      estimatedMissedAbuse: null,
      estimatedRecall: null,
      recallWithheld: 'too_few_unflagged_reviews',
    },
    cohorts: [],
    labelSources: {},
  };
  const run = { ranAt: WHEN, ranBy: REVIEWER, note: 'after retune', report };

  it('needs users:moderate and limits to 5 a minute', async () => {
    await loadRuns();
    expect(h.options.runs).toMatchObject({ adminPermissions: { POST: 'users:moderate' } });
    expect(h.rateLimit).toHaveBeenCalledWith({ limit: 5, windowMs: 60_000, bucket: 'admin-eval-set-run' });
  });

  it('runs the set, audits it and returns the run next to the previous one', async () => {
    const { post } = await loadRuns();
    h.runEvalSet.mockResolvedValue({ run, previous: null });
    const { req, res } = reqFor({ method: 'POST', query: { id: SET_ID }, body: { note: 'after retune' } });
    await post!(req, res);
    expect(h.runEvalSet).toHaveBeenCalledWith(SET_ID, REVIEWER, 'after retune');
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'abuse.eval_set.run' }));
    expect(JSON.parse(res._getData())).toMatchObject({ run: { note: 'after retune' }, previous: null });
  });

  it('takes an empty body and rejects an over-long note', async () => {
    const { post } = await loadRuns();
    h.runEvalSet.mockResolvedValue({ run, previous: null });
    const ok = reqFor({ method: 'POST', query: { id: SET_ID } });
    await post!(ok.req, ok.res);
    expect(h.runEvalSet).toHaveBeenCalledWith(SET_ID, REVIEWER, null);
    const bad = reqFor({ method: 'POST', query: { id: SET_ID }, body: { note: 'x'.repeat(501) } });
    await expect(post!(bad.req, bad.res)).rejects.toThrow('at most 500');
  });
});
