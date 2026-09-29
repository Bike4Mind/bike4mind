import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeResearchManage: vi.fn(),
  startResearchRun: vi.fn(),
  listByLake: vi.fn(),
  queueResearchRun: vi.fn(),
  queueUrl: undefined as string | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeResearchService: { startResearchRun: h.startResearchRun },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeResearchConfigRepository: {},
  dataLakeResearchRunRepository: { listByLake: h.listByLake },
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@server/dataLakes/assertLakeResearchManage', () => ({
  assertLakeResearchManage: h.assertLakeResearchManage,
}));
vi.mock('@server/dataLakes/queueResearchRun', () => ({ queueResearchRun: h.queueResearchRun }));
vi.mock('sst', () => ({
  Resource: {
    get dataLakeResearchQueue() {
      return h.queueUrl ? { url: h.queueUrl } : undefined;
    },
  },
}));

import handler from '../runs/index';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const req = (method: string, query: Record<string, string>, body?: unknown) =>
  ({ method, query, body, user: { id: 'user-1' }, logger: { warn: vi.fn(), error: vi.fn() } }) as never;

const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const queuedRun = { id: 'run-1', dataLakeId: 'lake-oid-1', status: 'queued', totals: { searchHits: 0 } };
const LAKE = { id: 'lake-oid-1', name: 'Ops Lake' };
const ACTOR = { userId: 'user-1', isAdmin: false, administeredOrgIds: [] };
const GRANTS: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.queueUrl = 'https://sqs.example/research';
  h.assertLakeResearchManage.mockResolvedValue({ lake: LAKE, actor: ACTOR, grants: GRANTS });
  h.listByLake.mockResolvedValue([queuedRun]);
  h.startResearchRun.mockResolvedValue(queuedRun);
  h.queueResearchRun.mockResolvedValue(undefined);
});

describe('GET /api/data-lakes/[id]/research/runs', () => {
  it('returns the run history for a manager, bounded by a default page size', async () => {
    const { res, json } = makeRes();

    await call(req('GET', { id: 'my-lake' }), res);

    expect(h.listByLake).toHaveBeenCalledWith('lake-oid-1', { limit: 20 });
    expect(json).toHaveBeenCalledWith({ data: [queuedRun] });
  });

  it('honors an explicit limit', async () => {
    const { res } = makeRes();
    await call(req('GET', { id: 'l', limit: '5' }), res);
    expect(h.listByLake).toHaveBeenCalledWith('lake-oid-1', { limit: 5 });
  });

  it('refuses a limit outside the allowed page range', async () => {
    const { res } = makeRes();
    await expect(call(req('GET', { id: 'l', limit: '500' }), res)).rejects.toThrow();
  });
});

describe('POST /api/data-lakes/[id]/research/runs', () => {
  it('queues a run and answers 202 with the queued row', async () => {
    const { res, json } = makeRes();

    await call(req('POST', { id: 'my-lake' }, { configId: 'config-1' }), res);

    expect(h.startResearchRun).toHaveBeenCalledWith(
      'config-1',
      LAKE,
      { trigger: 'on_demand', actor: ACTOR, grants: GRANTS },
      expect.anything()
    );
    expect(h.queueResearchRun).toHaveBeenCalledWith(queuedRun, LAKE, 'https://sqs.example/research', expect.anything());
    expect(res.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ data: queuedRun });
  });

  // Without the queue there is no executor, and a permanently-queued run holds the one-at-a-time
  // guard closed against every later attempt - so the row must never be written at all.
  it('refuses before writing a row when the deployment has no research queue', async () => {
    h.queueUrl = undefined;
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'l' }, { configId: 'config-1' }), res)).rejects.toThrow(/not available/i);
    expect(h.startResearchRun).not.toHaveBeenCalled();
  });

  it('propagates an enqueue failure rather than answering 202', async () => {
    h.queueResearchRun.mockRejectedValue(new Error('sqs is down'));
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'l' }, { configId: 'config-1' }), res)).rejects.toThrow(/sqs is down/);
  });

  it('requires a configId', async () => {
    const { res } = makeRes();
    await expect(call(req('POST', { id: 'l' }, {}), res)).rejects.toThrow();
    expect(h.startResearchRun).not.toHaveBeenCalled();
  });

  it('propagates the manage refusal on both verbs, before any read or write', async () => {
    h.assertLakeResearchManage.mockRejectedValue(new Error('You do not have permission to manage research runs'));

    await expect(call(req('GET', { id: 'l' }), makeRes().res)).rejects.toThrow(/permission to manage/i);
    await expect(call(req('POST', { id: 'l' }, { configId: 'c' }), makeRes().res)).rejects.toThrow(
      /permission to manage/i
    );

    expect(h.listByLake).not.toHaveBeenCalled();
    expect(h.startResearchRun).not.toHaveBeenCalled();
    expect(h.queueResearchRun).not.toHaveBeenCalled();
  });
});
