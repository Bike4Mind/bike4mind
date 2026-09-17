import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The enqueue route's contract: the org gate answers first, a window has to be sane before any
 * work is bought, and two requests for the same in-flight window buy one LLM pass between them.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  getContentAsString: null as null | (() => Promise<string>),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,

    // The route registers its rate limit per method, so the handler is the LAST argument.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (...fns: any[]) => {
      mockRefs.postHandler = fns[fns.length - 1];
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (...fns: any[]) => {
      mockRefs.getHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getContentAsString = async () => (mockRefs.getContentAsString ? mockRefs.getContentAsString() : '{}');
  },
}));

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const verifyOrgAccess = vi.hoisted(() => vi.fn(async () => ({ id: 'org1' })));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));

const sendToQueue = vi.hoisted(() => vi.fn(async () => 'message-id'));
vi.mock('@server/utils/sqs', () => ({ sendToQueue }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'https://queue.invalid/quest-export' }));

const jobCreate = vi.hoisted(() => vi.fn(async () => ({})));
const jobFindOne = vi.hoisted(() => vi.fn(() => ({ lean: async () => null as unknown })));
const jobUpdateOne = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@bike4mind/database', () => ({
  OrgFeedbackSummaryJob: { create: jobCreate, findOne: jobFindOne, updateOne: jobUpdateOne },
  ORG_FEEDBACK_SUMMARY_ACTIVE_KEY: 'active',
  ORG_FEEDBACK_SUMMARY_ACTIVE_STATUSES: ['pending', 'processing'],
}));

const WINDOW = { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-31T00:00:00.000Z' };

let handler: (req: unknown, res: unknown) => unknown;
let getHandler: (req: unknown, res: unknown) => unknown;

beforeAll(async () => {
  await import('../feedback-summary');
  handler = mockRefs.postHandler!;
  getHandler = mockRefs.getHandler!;
});

const invoke = async (body: unknown, user: unknown = { id: 'owner1', isAdmin: false }) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body });
  (req as unknown as { user: unknown }).user = user;
  await handler(req, res);
  return res;
};

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
const notFound = () => Object.assign(new Error('Organization not found'), { statusCode: 404 });

describe('POST /api/organizations/:id/feedback-summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyOrgAccess.mockResolvedValue({ id: 'org1' } as never);
    jobCreate.mockResolvedValue({} as never);
    jobFindOne.mockReturnValue({ lean: async () => null } as never);
    sendToQueue.mockResolvedValue('message-id' as never);
  });

  it('answers the org gate before writing a job or enqueuing anything', async () => {
    verifyOrgAccess.mockRejectedValue(notFound() as never);

    await expect(invoke(WINDOW)).rejects.toThrow('Organization not found');
    expect(jobCreate).not.toHaveBeenCalled();
    expect(sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before touching the org', async () => {
    await expect(invoke(WINDOW, null)).rejects.toThrow('Authentication required');
    expect(verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('enqueues one tagged message and answers 202', async () => {
    const res = await invoke(WINDOW);

    expect(res._getStatusCode()).toBe(202);
    const body = res._getJSONData();
    expect(body.reused).toBe(false);
    expect(body.summaryJobId).toBeTruthy();

    expect(sendToQueue).toHaveBeenCalledTimes(1);
    const message = sendToQueue.mock.calls[0][1] as Record<string, unknown>;
    expect(message.jobType).toBe('orgFeedbackSummary');
    expect(message.organizationId).toBe('org1');
    expect(message.summaryJobId).toBe(body.summaryJobId);
    expect(message.userId).toBe('owner1');

    // The job is held by the constant key, which is what a second request collides with.
    const created = jobCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(created.status).toBe('pending');
    expect(created.activeKey).toBe('active');
    expect(created.requestedBy).toBe('owner1');
  });

  it('joins the job already running on this window instead of buying a second LLM pass', async () => {
    jobCreate.mockRejectedValue(duplicateKey() as never);
    jobFindOne.mockReturnValue({ lean: async () => ({ summaryJobId: 'existing-job' }) } as never);

    const res = await invoke(WINDOW);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ summaryJobId: 'existing-job', reused: true });
    expect(sendToQueue).not.toHaveBeenCalled();
    // Only an in-flight job holds the window; a completed one has released its key.
    const filter = jobFindOne.mock.calls[0][0] as { status: { $in: string[] } };
    expect(filter.status.$in).toEqual(['pending', 'processing']);
  });

  it('rejects an inverted range, an oversized one and a missing one without enqueuing', async () => {
    await expect(invoke({ startDate: WINDOW.endDate, endDate: WINDOW.startDate })).rejects.toThrow();
    await expect(
      invoke({ startDate: '2020-01-01T00:00:00.000Z', endDate: '2026-01-01T00:00:00.000Z' })
    ).rejects.toThrow();
    await expect(invoke({ startDate: WINDOW.startDate })).rejects.toThrow();
    await expect(invoke({ startDate: '01/01/2026', endDate: '01/31/2026' })).rejects.toThrow();

    expect(jobCreate).not.toHaveBeenCalled();
    expect(sendToQueue).not.toHaveBeenCalled();
  });

  it('releases the window when the enqueue fails, so the next request is not locked out', async () => {
    sendToQueue.mockRejectedValue(new Error('SQS unavailable') as never);

    await expect(invoke(WINDOW)).rejects.toThrow('SQS unavailable');

    expect(jobUpdateOne).toHaveBeenCalledTimes(1);
    const update = jobUpdateOne.mock.calls[0][1] as Record<string, unknown>;
    expect(update.status).toBe('failed');
    // Swapped off the shared constant, or the window stays held until the TTL expires.
    expect(update.activeKey).not.toBe('active');
  });
});

/**
 * The read the panel polls after a completion frame. It re-runs the same org gate as the enqueue -
 * a signed URL handed out once would not.
 */
describe('GET /api/organizations/:id/feedback-summary', () => {
  const runGet = async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'org1', ...WINDOW } });
    (req as unknown as { user: unknown }).user = { id: 'owner1', isAdmin: false };
    await getHandler(req, res);
    return res;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    verifyOrgAccess.mockResolvedValue({ id: 'org1' } as never);
    jobFindOne.mockReturnValue({ sort: () => ({ lean: async () => null }) } as never);
  });

  it('answers "none" for a window nobody has asked about', async () => {
    const res = await runGet();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ status: 'none' });
  });

  it('reads the artifact back for a completed job', async () => {
    const artifact = { summaryJobId: 'sum-1', summary: 'Steady week.' };
    jobFindOne.mockReturnValue({
      sort: () => ({ lean: async () => ({ summaryJobId: 'sum-1', status: 'completed', s3Key: 'k' }) }),
    } as never);
    mockRefs.getContentAsString = async () => JSON.stringify(artifact);

    const res = await runGet();

    expect(res._getJSONData()).toEqual({ status: 'completed', summaryJobId: 'sum-1', artifact });
  });

  it('reports a failed job with its reason instead of an artifact', async () => {
    jobFindOne.mockReturnValue({
      sort: () => ({ lean: async () => ({ summaryJobId: 'sum-1', status: 'failed', errorMessage: 'no model' }) }),
    } as never);

    const res = await runGet();

    expect(res._getJSONData()).toEqual({ status: 'failed', summaryJobId: 'sum-1', errorMessage: 'no model' });
  });

  it('refuses a caller who may not administer the org', async () => {
    verifyOrgAccess.mockRejectedValue(notFound() as never);

    await expect(runGet()).rejects.toThrow('Organization not found');
    expect(jobFindOne).not.toHaveBeenCalled();
  });
});
