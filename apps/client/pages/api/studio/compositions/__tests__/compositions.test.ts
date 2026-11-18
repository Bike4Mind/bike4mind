// @vitest-environment node
/**
 * Route tests for /api/studio/compositions and /api/studio/compositions/[id]. `baseApi`, CSRF, rate limiting and
 * the feature flag are stubbed and the service is mocked; the routes' own flag wiring, parsing and response
 * shaping run for real. Ownership rules are covered by the service and repository tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { StudioCompositionContentSchema, defaultStudioTimeline } from '@bike4mind/common';

type Mw = (req: unknown, res: MockRes, next: () => void) => unknown;
type MockRes = { status: (code: number) => { json: (body: unknown) => unknown } };

const mocks = vi.hoisted(() => ({
  service: {
    createComposition: vi.fn(),
    listCompositions: vi.fn(),
    getComposition: vi.fn(),
    updateComposition: vi.fn(),
    deleteComposition: vi.fn(),
  },
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
      patch: route('PATCH'),
      delete: route('DELETE'),
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
vi.mock('@bike4mind/services', () => ({ studioCompositionService: mocks.service }));
vi.mock('@server/studio/studioCompositionAdapters', () => ({ studioCompositionAdapters: { db: 'adapters' } }));

const { default: collectionHandler } = await import('../index');
const { default: itemHandler } = await import('../[id]');

const USER = { id: 'user-1' };
const ID = 'a'.repeat(24);
const ADAPTERS = { db: 'adapters' };
const createdAt = new Date('2026-01-01T00:00:00.000Z');
/** A stored document, carrying the ownership fields the response must drop. */
const COMPOSITION = {
  ...StudioCompositionContentSchema.parse({ title: 'Spring ad', timeline: defaultStudioTimeline('ad_campaign') }),
  id: ID,
  userId: USER.id,
  organizationId: 'org-1',
  createdAt,
  updatedAt: createdAt,
};
const { userId: _userId, organizationId: _organizationId, ...publicFields } = COMPOSITION;
const COMPOSITION_JSON = JSON.parse(JSON.stringify(publicFields));

type Handler = (req: unknown, res: unknown) => Promise<void>;
const call = async (
  handler: unknown,
  options: { method: string; body?: unknown; query?: Record<string, string> }
): Promise<{ status: number; body: unknown }> => {
  const { req, res } = createMocks({
    method: options.method as 'GET',
    body: options.body as Record<string, unknown> | undefined,
    query: options.query,
  });
  Object.assign(req, { user: USER });
  await (handler as Handler)(req, res);
  const raw = res._getData();
  return { status: res._getStatusCode(), body: raw === '' ? undefined : res._getJSONData() };
};

describe('/api/studio/compositions routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flag.open = true;
  });

  it('gates both routes on the Productions Studio feature', async () => {
    expect(mocks.flag.features).toEqual(['productions', 'productions']);
    mocks.flag.open = false;
    expect((await call(collectionHandler, { method: 'POST', body: { title: 'x' } })).status).toBe(403);
    expect((await call(itemHandler, { method: 'DELETE', query: { id: ID } })).status).toBe(403);
    expect(mocks.service.createComposition).not.toHaveBeenCalled();
    expect(mocks.service.deleteComposition).not.toHaveBeenCalled();
  });

  describe('POST /api/studio/compositions', () => {
    it('creates for the session user with the parsed body', async () => {
      mocks.service.createComposition.mockResolvedValue(COMPOSITION);
      const { status, body } = await call(collectionHandler, { method: 'POST', body: { title: ' Spring ad ' } });

      expect(status).toBe(201);
      expect(body).toEqual({ composition: COMPOSITION_JSON });
      expect(mocks.service.createComposition).toHaveBeenCalledWith(
        USER.id,
        ADAPTERS,
        expect.objectContaining({ title: 'Spring ad', template: 'ad_campaign' })
      );
    });

    it('answers 400 for a body that names the owner', async () => {
      const { status } = await call(collectionHandler, { method: 'POST', body: { title: 'x', userId: 'someone' } });
      expect(status).toBe(400);
      expect(mocks.service.createComposition).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/studio/compositions', () => {
    it("lists the caller's compositions as summaries with a defaulted page", async () => {
      const { shots: _shots, timeline: _timeline, ...summary } = COMPOSITION;
      mocks.service.listCompositions.mockResolvedValue([summary]);
      const { status, body } = await call(collectionHandler, { method: 'GET' });
      expect(status).toBe(200);
      const { shots: _s, timeline: _t, ...summaryJson } = COMPOSITION_JSON;
      expect(body).toEqual({ data: [summaryJson] });
      expect(mocks.service.listCompositions).toHaveBeenCalledWith(USER.id, ADAPTERS, { limit: 50, skip: 0 });
    });

    it('answers 400 for a page size past the cap', async () => {
      expect((await call(collectionHandler, { method: 'GET', query: { limit: '1000' } })).status).toBe(400);
    });
  });

  describe('/api/studio/compositions/[id]', () => {
    it('answers 404 without a lookup for a malformed or uppercase id', async () => {
      for (const id of ['nope', 'A'.repeat(24)]) {
        expect((await call(itemHandler, { method: 'GET', query: { id } })).status).toBe(404);
      }
      expect(mocks.service.getComposition).not.toHaveBeenCalled();
    });

    it('gets, patches and deletes for the session user', async () => {
      mocks.service.getComposition.mockResolvedValue(COMPOSITION);
      mocks.service.updateComposition.mockResolvedValue({ ...COMPOSITION, title: 'Renamed' });

      expect(await call(itemHandler, { method: 'GET', query: { id: ID } })).toEqual({
        status: 200,
        body: { composition: COMPOSITION_JSON },
      });
      expect(mocks.service.getComposition).toHaveBeenCalledWith(USER.id, ADAPTERS, ID);

      const patched = await call(itemHandler, { method: 'PATCH', query: { id: ID }, body: { projectId: null } });
      expect(patched.status).toBe(200);
      expect(mocks.service.updateComposition).toHaveBeenCalledWith(USER.id, ADAPTERS, ID, { projectId: null });

      expect((await call(itemHandler, { method: 'DELETE', query: { id: ID } })).status).toBe(204);
      expect(mocks.service.deleteComposition).toHaveBeenCalledWith(USER.id, ADAPTERS, ID);
    });

    it('answers 400 for an empty patch', async () => {
      expect((await call(itemHandler, { method: 'PATCH', query: { id: ID }, body: {} })).status).toBe(400);
      expect(mocks.service.updateComposition).not.toHaveBeenCalled();
    });
  });
});
