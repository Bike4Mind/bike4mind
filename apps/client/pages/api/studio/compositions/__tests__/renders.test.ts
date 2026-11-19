// @vitest-environment node
/**
 * Route tests for /api/studio/compositions/[id]/renders. `baseApi`, CSRF, rate limiting, the feature flag, the AI
 * access guard and billing-org resolution are stubbed and createRenderJobs is mocked; the route's own parsing,
 * response shaping and listing filter run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CreditHolderType, StudioRenderCreateResponseSchema, type IGenerationJobDocumentOf } from '@bike4mind/common';

type Mw = (req: unknown, res: MockRes, next: () => void) => unknown;
type MockRes = { status: (code: number) => { json: (body: unknown) => unknown } };

const mocks = vi.hoisted(() => ({
  createRenderJobs: vi.fn(),
  listByRequester: vi.fn(),
  assertAiAccessAllowed: vi.fn(),
  resolveMediaBillingOrgId: vi.fn(),
  deps: { stub: 'render-deps' },
  flag: { open: true, features: [] as string[] },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const used: Mw[] = [];
    const routes: Record<string, Mw[]> = {};
    const dispatch = async (req: { method: string }, res: MockRes) => {
      for (const handler of [...used, ...(routes[req.method] ?? [])]) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
    const route =
      (method: string) =>
      (...handlers: Mw[]) => {
        routes[method] = handlers;
        return chain;
      };
    const chain = Object.assign(dispatch, {
      use: (mw: Mw) => {
        used.push(mw);
        return chain;
      },
      get: route('GET'),
      post: route('POST'),
    });
    return chain;
  },
}));
const passThrough = () => (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: passThrough }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: passThrough }));
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({
  requireStudioFeature: (feature: string) => {
    mocks.flag.features.push(feature);
    return (_req: unknown, res: MockRes, next: () => void) =>
      mocks.flag.open ? next() : res.status(403).json({ error: 'FEATURE_DISABLED' });
  },
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({
  assertAiAccessAllowed: mocks.assertAiAccessAllowed,
}));
vi.mock('@bike4mind/server-utils/generationJobs/wiring', () => ({ getCreateRenderJobsDeps: () => mocks.deps }));
vi.mock('@server/billing/resolveMediaBillingOrgId', () => ({
  resolveMediaBillingOrgId: mocks.resolveMediaBillingOrgId,
}));
vi.mock('@bike4mind/services/renderJobs', () => ({ createRenderJobs: mocks.createRenderJobs }));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({
  getUserEntitlements: async () => ['plan:paid'],
  toEntitlementUser: (user: unknown) => user,
}));
vi.mock('@bike4mind/database', () => ({ generationJobRepository: { listByRequester: mocks.listByRequester } }));

const { default: handler } = await import('../[id]/renders');

type RenderJob = IGenerationJobDocumentOf<'render'>;

const USER = { id: 'user-1' };
const ID = 'a'.repeat(24);
const OUTPUT = { id: 'out-wide', aspectRatio: '16:9', width: 1920, height: 1080 } as const;

const renderJob = (overrides: { id: string; compositionId: string }): RenderJob => ({
  id: overrides.id,
  kind: 'render',
  ownerType: CreditHolderType.User,
  ownerId: USER.id,
  requestedBy: USER.id,
  source: 'studio',
  state: 'pending',
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-11-17T01:00:00Z'),
  creditHold: null,
  createdAt: new Date('2026-11-17T00:00:00Z'),
  payload: {
    request: {
      compositionId: overrides.compositionId,
      title: 'Spring ad',
      output: OUTPUT,
      timeline: { version: 1, durationMs: 1000, fps: 30, backgroundColor: '#000000', outputs: [OUTPUT], tracks: [] },
    },
    pricing: { usdPerOutputSecond: 0.01, billedSeconds: 1, usd: 0.01 },
    groupId: 'c'.repeat(24),
    groupSize: 1,
  },
});

type Handler = (req: unknown, res: unknown) => Promise<void>;
const call = async (options: {
  method: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string>;
}): Promise<{ status: number; body: unknown }> => {
  const { req, res } = createMocks({
    method: options.method,
    body: options.body as Record<string, unknown> | undefined,
    query: options.query ?? { id: ID },
  });
  Object.assign(req, { user: USER });
  await (handler as unknown as Handler)(req, res);
  const raw = res._getData();
  return { status: res._getStatusCode(), body: raw === '' ? undefined : res._getJSONData() };
};

describe('/api/studio/compositions/[id]/renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flag.open = true;
    mocks.resolveMediaBillingOrgId.mockResolvedValue('org-1');
  });

  it('gates the route on the Productions Studio feature', async () => {
    expect(mocks.flag.features).toEqual(['productions']);
    mocks.flag.open = false;
    expect((await call({ method: 'POST', body: { outputIds: ['out-wide'] } })).status).toBe(403);
    expect((await call({ method: 'GET' })).status).toBe(403);
    expect(mocks.createRenderJobs).not.toHaveBeenCalled();
    expect(mocks.listByRequester).not.toHaveBeenCalled();
  });

  describe('POST', () => {
    it('starts the export for the session user and answers 202 with the jobs', async () => {
      const job = renderJob({ id: '1'.repeat(24), compositionId: ID });
      mocks.createRenderJobs.mockResolvedValue({ ok: true, groupId: 'c'.repeat(24), jobs: [job] });

      const { status, body } = await call({ method: 'POST', body: { outputIds: ['out-wide'] } });

      expect(status).toBe(202);
      expect(StudioRenderCreateResponseSchema.parse(body)).toMatchObject({
        groupId: 'c'.repeat(24),
        jobs: [{ id: job.id, compositionId: ID, state: 'pending', output: OUTPUT }],
      });
      expect(mocks.assertAiAccessAllowed).toHaveBeenCalledWith(USER);
      expect(mocks.createRenderJobs).toHaveBeenCalledWith(
        {
          user: { id: USER.id, organizationId: 'org-1', isAdmin: undefined, tags: undefined },
          getEntitlements: expect.any(Function),
          compositionId: ID,
          outputIds: ['out-wide'],
        },
        mocks.deps
      );
      const [[input]] = mocks.createRenderJobs.mock.calls;
      await expect(input.getEntitlements()).resolves.toEqual(['plan:paid']);
    });

    it('passes a refusal through with its status and code', async () => {
      mocks.createRenderJobs.mockResolvedValue({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
        message: 'You do not have enough credits',
      });
      const { status, body } = await call({ method: 'POST', body: { outputIds: ['out-wide'] } });
      expect(status).toBe(402);
      expect(body).toEqual({ error: 'insufficient_credits', message: 'You do not have enough credits' });
    });

    it.each([
      ['no output ids', { outputIds: [] }],
      ['too many output ids', { outputIds: Array.from({ length: 9 }, (_, index) => `o${index}`) }],
      ['an unknown key', { outputIds: ['out-wide'], userId: 'someone' }],
      ['a missing body', {}],
    ])('answers 400 for %s', async (_label, body) => {
      const { status, body: responseBody } = await call({ method: 'POST', body });
      expect(status).toBe(400);
      expect(responseBody).toMatchObject({ error: 'invalid_request' });
      expect(mocks.createRenderJobs).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed composition id', async () => {
      const { status, body } = await call({
        method: 'POST',
        body: { outputIds: ['out-wide'] },
        query: { id: 'not-an-id' },
      });
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'not_found', message: 'Composition not found' });
      expect(mocks.createRenderJobs).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it("lists the caller's renders of this composition, filtered by the query and dropping other kinds", async () => {
      const mine = renderJob({ id: '1'.repeat(24), compositionId: ID });
      const notARender = { ...renderJob({ id: '3'.repeat(24), compositionId: ID }), kind: 'video' };
      mocks.listByRequester.mockResolvedValue([mine, notARender]);

      const { status, body } = await call({ method: 'GET' });

      expect(status).toBe(200);
      expect(body).toMatchObject({ data: [{ id: mine.id, compositionId: ID }] });
      expect((body as { data: unknown[] }).data).toHaveLength(1);
      expect(mocks.listByRequester).toHaveBeenCalledWith({
        requestedBy: USER.id,
        kind: 'render',
        compositionId: ID,
        limit: 100,
      });
    });

    it('answers 404 for a malformed composition id', async () => {
      expect((await call({ method: 'GET', query: { id: 'nope' } })).status).toBe(404);
      expect(mocks.listByRequester).not.toHaveBeenCalled();
    });
  });
});
