// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, OPTI_SURFACE } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
  rateLimiter: () => undefined,
  postArgs: [] as RouteHandler[],
  cloneSession: vi.fn(),
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (...fns: RouteHandler[]) => {
      h.postArgs = fns;
      h.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return {
    baseApi: (options: unknown) => {
      h.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    h.rateLimitOptions = options;
    return h.rateLimiter;
  },
}));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: h.getRequestEntitlements }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ sessionService: { cloneSession: h.cloneSession } }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  questRepository: {},
  Session: class {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: () => unknown) => fn(),
}));

await import('../clone');

const call = (body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'session-1' }, body });
  Object.assign(req, { user: { id: 'user-1', tags: [] }, ability: { can: () => true } });
  return { run: () => h.postHandler!(req, res) };
};

describe('POST /api/sessions/[id]/clone - targetSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cloneSession.mockResolvedValue({ id: 'clone-1', name: 'Cloned', knowledgeIds: [], agentIds: [] });
    h.getRequestEntitlements.mockResolvedValue(['optihashi:pro']);
  });

  // Only API-key callers are scope-gated; JWT/browser callers (no req.apiKey, as below) clone as before.
  it('requires notebooks:write from an API key', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['notebooks:write'] });
  });

  it('rate-limits clones per caller on a route-wide bucket, mounted ahead of the handler', () => {
    expect(h.rateLimitOptions).toEqual({ limit: 10, windowMs: 60_000, bucket: 'sessions/clone' });
    expect(h.postArgs).toHaveLength(2);
    expect(h.postArgs[0]).toBe(h.rateLimiter);
  });

  it('403s a caller whose ability cannot clone', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'session-1' } });
    Object.assign(req, { user: { id: 'user-1', tags: [] }, ability: { can: () => false } });

    await expect(h.postHandler!(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.cloneSession).not.toHaveBeenCalled();
  });

  it('inherits when the body names no target', async () => {
    await call().run();

    expect(h.cloneSession.mock.calls[0][1]).toEqual({ id: 'session-1', targetSurface: undefined });
  });

  it('forwards the target and the caller surface access to the service', async () => {
    await call({ targetSurface: OPTI_SURFACE }).run();

    const [, params, adapters] = h.cloneSession.mock.calls[0];
    expect(params).toEqual({ id: 'session-1', targetSurface: OPTI_SURFACE });
    await expect(adapters.resolveSurfaceAccess()).resolves.toMatchObject({ entitlements: ['optihashi:pro'] });
  });

  it('400s a malformed target before cloning', async () => {
    await expect(call({ targetSurface: 42 }).run()).rejects.toBeInstanceOf(BadRequestError);
    expect(h.cloneSession).not.toHaveBeenCalled();
  });
});
