// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, OPTI_SURFACE, sessionCloneContract } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  contract: undefined as unknown,
  routeOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
  rateLimiter: (() => undefined) as RouteHandler,
  cloneSession: vi.fn(),
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => {
  const chain = {
    post: (fn: RouteHandler) => {
      h.postHandler = fn;
      return chain;
    },
  };
  return {
    nextRouteForContract: (contract: unknown, options: unknown) => {
      h.contract = contract;
      h.routeOptions = options;
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

await import('../../../v1/sessions/[id]/clone');

const call = (body?: Record<string, unknown>, canClone = true) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'session-1' }, body });
  Object.assign(req, {
    user: { id: 'user-1', tags: [] },
    ability: { can: () => canClone },
    validatedParams: { id: 'session-1' },
    validated: sessionCloneContract.request.parse(body),
  });
  return { run: () => h.postHandler!(req, res) };
};

describe('POST /api/sessions/[id]/clone - targetSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cloneSession.mockResolvedValue({ id: 'clone-1', name: 'Cloned', knowledgeIds: [], agentIds: [] });
    h.getRequestEntitlements.mockResolvedValue(['optihashi:pro']);
  });

  it('derives auth, scope, and validation from the clone contract', () => {
    expect(h.contract).toBe(sessionCloneContract);
    expect(sessionCloneContract.path).toBe('/api/v1/sessions/{id}/clone');
    expect(sessionCloneContract.scopes).toEqual(['notebooks:write']);
    expect(sessionCloneContract.validationErrorStatus).toBe(400);
  });

  it('rate-limits clones per caller on a route-wide bucket', () => {
    expect(h.rateLimitOptions).toEqual({ limit: 10, windowMs: 60_000, bucket: 'sessions/clone' });
    expect(h.routeOptions).toEqual({ rateLimit: h.rateLimiter });
  });

  it('403s a caller whose ability cannot clone', async () => {
    await expect(call(undefined, false).run()).rejects.toBeInstanceOf(ForbiddenError);
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
    expect(sessionCloneContract.request.safeParse({ targetSurface: 42 }).success).toBe(false);
    expect(sessionCloneContract.responses[400]).toBeDefined();
    expect(h.cloneSession).not.toHaveBeenCalled();
  });
});
