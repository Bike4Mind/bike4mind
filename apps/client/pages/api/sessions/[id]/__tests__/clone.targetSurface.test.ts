// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, OPTI_SURFACE } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  cloneSession: vi.fn(),
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: RouteHandler) => {
      h.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
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
