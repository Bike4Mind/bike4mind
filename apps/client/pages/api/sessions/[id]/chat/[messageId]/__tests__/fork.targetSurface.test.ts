// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, OPTI_SURFACE } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  forkSession: vi.fn(),
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
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: RouteHandler) => fn }));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: h.getRequestEntitlements }));
vi.mock('@server/services/gears/stampGear', () => ({ stampGear: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ sessionService: { forkSession: h.forkSession } }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  questRepository: {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: () => unknown) => fn(),
}));

await import('../fork');

const call = (body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'session-1', messageId: 'm1' }, body });
  Object.assign(req, { user: { id: 'user-1', tags: [] } });
  return { run: () => h.postHandler!(req, res) };
};

describe('POST /api/sessions/[id]/chat/[messageId]/fork - targetSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.forkSession.mockResolvedValue({ id: 'fork-1', name: 'Forked' });
    h.getRequestEntitlements.mockResolvedValue(['optihashi:pro']);
  });

  it('inherits when the body names no target', async () => {
    await call().run();

    expect(h.forkSession.mock.calls[0][1]).toEqual({
      sessionId: 'session-1',
      messageId: 'm1',
      targetSurface: undefined,
    });
  });

  it('forwards the target and the caller surface access to the service', async () => {
    await call({ targetSurface: null }).run();

    const [, params, adapters] = h.forkSession.mock.calls[0];
    expect(params).toEqual({ sessionId: 'session-1', messageId: 'm1', targetSurface: null });
    await expect(adapters.resolveSurfaceAccess()).resolves.toMatchObject({ entitlements: ['optihashi:pro'] });
  });

  it('400s a malformed target before forking', async () => {
    await expect(call({ targetSurface: { id: OPTI_SURFACE } }).run()).rejects.toBeInstanceOf(BadRequestError);
    expect(h.forkSession).not.toHaveBeenCalled();
  });
});
