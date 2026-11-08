// @vitest-environment node
/**
 * Route tests for POST and GET /api/studio/image-jobs. `baseApi` and the feature flag are stubbed (no DB,
 * no auth chain); the route's own body/query validation, response shaping and refusal mapping run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Mw = (req: unknown, res: MockRes, next: () => void) => unknown;
type MockRes = { status: (code: number) => { json: (body: unknown) => unknown } };

const mocks = vi.hoisted(() => ({
  createImageJobs: vi.fn(),
  getCreateImageJobsDeps: vi.fn(),
  listOwnGenerationJobs: vi.fn(),
  resolveMediaBillingOrgId: vi.fn(),
  assertAiAccessAllowed: vi.fn(),
  flag: { open: true },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const used: Mw[] = [];
    const routes: Record<string, Mw[]> = {};
    const dispatch = async (req: { method: string }, res: MockRes) => {
      const chain = [...used, ...(routes[req.method] ?? [])];
      for (const handler of chain) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
    const chain = Object.assign(dispatch, {
      use: (mw: Mw) => {
        used.push(mw);
        return chain;
      },
      get: (...handlers: Mw[]) => {
        routes.GET = handlers;
        return chain;
      },
      post: (...handlers: Mw[]) => {
        routes.POST = handlers;
        return chain;
      },
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({
  requireStudioFeature: () => (_req: unknown, res: MockRes, next: () => void) =>
    mocks.flag.open ? next() : res.status(403).json({ error: 'FEATURE_DISABLED' }),
}));
vi.mock('@bike4mind/services/imageJobs', () => ({ createImageJobs: mocks.createImageJobs }));
vi.mock('@server/generationJobs/wiring', () => ({ getCreateImageJobsDeps: mocks.getCreateImageJobsDeps }));
vi.mock('@server/generations/listOwnGenerationJobs', () => ({ listOwnGenerationJobs: mocks.listOwnGenerationJobs }));
vi.mock('@server/billing/resolveMediaBillingOrgId', () => ({
  resolveMediaBillingOrgId: mocks.resolveMediaBillingOrgId,
}));
vi.mock('@server/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: mocks.assertAiAccessAllowed }));

const { default: handler } = await import('../index');

const USER = { id: 'user-1' };
const DEPS = { deps: true };
const REQUEST = { model: 'gpt-image-1', prompt: 'a bike' };

type Method = 'GET' | 'POST';
const call = async (options: {
  method: Method;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) => {
  const { req, res } = createMocks({
    method: options.method,
    body: options.body as Record<string, unknown> | undefined,
    query: options.query,
    headers: options.headers,
  });
  Object.assign(req, { user: USER });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

const createdAt = new Date('2026-01-01T00:00:00.000Z');
/** A full job document, carrying the server-only fields the Studio shape must drop. */
const jobDoc = (id: string) => ({
  id,
  kind: 'image',
  state: 'succeeded',
  attempts: 2,
  leaseOwner: 'worker-1',
  leaseExpiresAt: createdAt,
  creditHold: { id: 'hold-1', amount: 10 },
  error: { code: 'provider_error', message: 'boom', providerDetail: 'secret' },
  userId: 'user-1',
  createdAt,
  payload: {
    groupId: 'group-1',
    request: REQUEST,
    creditHold: { id: 'hold-1' },
    output: { fileId: 'file-1', contentType: 'image/png', bytes: 123, s3Key: 'private/key' },
  },
});

const PUBLIC_JOB_KEYS = ['createdAt', 'error', 'groupId', 'id', 'output', 'request', 'state'];

describe('/api/studio/image-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flag.open = true;
    mocks.getCreateImageJobsDeps.mockReturnValue(DEPS);
    mocks.resolveMediaBillingOrgId.mockResolvedValue('org-1');
  });

  describe('POST', () => {
    it('answers 403 and does not create jobs when the Studio flag is off', async () => {
      mocks.flag.open = false;
      const { status, body } = await call({ method: 'POST', body: { count: 1, request: REQUEST } });
      expect(status).toBe(403);
      expect(body).toEqual({ error: 'FEATURE_DISABLED' });
      expect(mocks.createImageJobs).not.toHaveBeenCalled();
    });

    it('creates jobs for the caller and billing org, scoping the idempotency key to the user', async () => {
      mocks.createImageJobs.mockResolvedValue({ ok: true, created: true, groupId: 'group-1', jobs: [jobDoc('j1')] });
      const { status, body } = await call({
        method: 'POST',
        body: { count: 2, request: REQUEST },
        headers: { 'idempotency-key': 'k1' },
      });
      expect(status).toBe(202);
      expect(mocks.createImageJobs).toHaveBeenCalledWith(
        {
          user: { id: 'user-1', organizationId: 'org-1' },
          request: REQUEST,
          count: 2,
          source: 'studio',
          idempotencyKey: 'studio:user-1:k1',
        },
        DEPS
      );
      expect(body.groupId).toBe('group-1');
      const [job] = body.jobs as Record<string, unknown>[];
      expect(Object.keys(job).sort()).toEqual(PUBLIC_JOB_KEYS);
      expect(job).toEqual({
        id: 'j1',
        groupId: 'group-1',
        state: 'succeeded',
        request: REQUEST,
        error: { code: 'provider_error', message: 'boom' },
        output: { fileId: 'file-1', contentType: 'image/png', bytes: 123 },
        createdAt: createdAt.toISOString(),
      });
      const serialized = JSON.stringify(body);
      for (const leaked of ['creditHold', 'attempts', 'leaseOwner', 'providerDetail', 's3Key']) {
        expect(serialized).not.toContain(leaked);
      }
    });

    it('omits the idempotency key when the header is absent', async () => {
      mocks.createImageJobs.mockResolvedValue({ ok: true, created: true, groupId: 'g', jobs: [] });
      await call({ method: 'POST', body: { count: 1, request: REQUEST } });
      const [input] = mocks.createImageJobs.mock.calls[0] as [Record<string, unknown>];
      expect(input).not.toHaveProperty('idempotencyKey');
    });

    it('answers 200 for an idempotent replay', async () => {
      mocks.createImageJobs.mockResolvedValue({ ok: true, created: false, groupId: 'group-1', jobs: [jobDoc('j1')] });
      const { status, body } = await call({
        method: 'POST',
        body: { count: 1, request: REQUEST },
        headers: { 'idempotency-key': 'k1' },
      });
      expect(status).toBe(200);
      expect(body.groupId).toBe('group-1');
    });

    it('answers 422 with every why-not reason when the model cannot honour the request', async () => {
      const failures = [
        { field: 'size', reason: 'size not supported' },
        { field: 'quality', reason: 'quality not supported' },
      ];
      mocks.createImageJobs.mockResolvedValue({
        ok: false,
        status: 422,
        code: 'unsupported_by_model',
        message: 'size not supported',
        failures,
      });
      const { status, body } = await call({ method: 'POST', body: { count: 1, request: REQUEST } });
      expect(status).toBe(422);
      expect(body).toEqual({ error: 'unsupported_by_model', message: 'size not supported', failures });
    });

    it('answers 400 with the storage figures on a storage refusal', async () => {
      const storage = { usedBytes: 10, limitBytes: 5 };
      mocks.createImageJobs.mockResolvedValue({
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        message: 'Storage full',
        storage,
      });
      const { status, body } = await call({ method: 'POST', body: { count: 1, request: REQUEST } });
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'storage_quota_exceeded', message: 'Storage full', storage });
    });

    it('answers 402 when credits are insufficient, without failures or storage', async () => {
      mocks.createImageJobs.mockResolvedValue({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
        message: 'Not enough credits',
      });
      const { status, body } = await call({ method: 'POST', body: { count: 1, request: REQUEST } });
      expect(status).toBe(402);
      expect(body).toEqual({ error: 'insufficient_credits', message: 'Not enough credits' });
    });

    it.each([
      ['count is missing', { request: REQUEST }],
      ['count is not a number', { count: '2', request: REQUEST }],
      ['the body carries extra keys', { count: 1, request: REQUEST, userId: 'someone-else' }],
    ])('answers 400 and creates nothing when %s', async (_label, body) => {
      const result = await call({ method: 'POST', body });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
      expect(mocks.createImageJobs).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('lists the caller image jobs with the default limit and the studio cursor scope', async () => {
      mocks.listOwnGenerationJobs.mockResolvedValue({ jobs: [jobDoc('j1')], nextCursor: 'next-1' });
      const { status, body } = await call({ method: 'GET' });
      expect(status).toBe(200);
      expect(mocks.listOwnGenerationJobs).toHaveBeenCalledWith({
        limit: 20,
        userId: 'user-1',
        kind: 'image',
        cursorScope: 'studio.image-jobs',
      });
      expect(body.next_cursor).toBe('next-1');
      const [job] = body.data as Record<string, unknown>[];
      expect(Object.keys(job).sort()).toEqual(PUBLIC_JOB_KEYS);
    });

    it('forwards limit and cursor', async () => {
      mocks.listOwnGenerationJobs.mockResolvedValue({ jobs: [], nextCursor: null });
      const { status, body } = await call({ method: 'GET', query: { limit: '5', cursor: 'c1' } });
      expect(status).toBe(200);
      expect(body).toEqual({ data: [], next_cursor: null });
      expect(mocks.listOwnGenerationJobs).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, cursor: 'c1', userId: 'user-1' })
      );
    });

    it('answers 400 when limit is above the maximum', async () => {
      const { status } = await call({ method: 'GET', query: { limit: '500' } });
      expect(status).toBe(400);
      expect(mocks.listOwnGenerationJobs).not.toHaveBeenCalled();
    });
  });
});
