// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, OPTI_SURFACE } from '@bike4mind/common';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  patchHandler: null as null | RouteHandler,
  baseApiOptions: undefined as unknown,
  moveSession: vi.fn(),
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    patch: (fn: RouteHandler) => {
      h.patchHandler = fn;
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
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: h.getRequestEntitlements }));
vi.mock('@bike4mind/services', () => ({ sessionService: { moveSession: h.moveSession } }));
vi.mock('@bike4mind/database', () => ({ sessionRepository: {} }));

await import('../surface');

const call = (body: unknown, query: Record<string, string> = { id: 'session-1' }) => {
  const { req, res } = createMocks({ method: 'PATCH', query, body: body as Record<string, unknown> });
  Object.assign(req, { user: { id: 'user-1', isAdmin: false, tags: ['opti'] } });
  return { run: () => h.patchHandler!(req, res), res };
};

describe('PATCH /api/sessions/[id]/surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.moveSession.mockResolvedValue({ id: 'session-1', surface: OPTI_SURFACE, systemPromptText: 'secret' });
    h.getRequestEntitlements.mockResolvedValue(['optihashi:pro']);
  });

  it('requires notebooks:write from an API key', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['notebooks:write'] });
  });

  it('moves the session for the caller and redacts the response', async () => {
    const { run, res } = call({ targetSurface: OPTI_SURFACE });

    await run();

    expect(h.moveSession).toHaveBeenCalledWith(
      'user-1',
      { id: 'session-1', targetSurface: OPTI_SURFACE },
      expect.objectContaining({ resolveSurfaceAccess: expect.any(Function) })
    );
    const body = res._getJSONData();
    expect(body.surface).toBe(OPTI_SURFACE);
    expect(body).not.toHaveProperty('systemPromptText');
  });

  it('hands the service the caller resolved entitlements', async () => {
    await call({ targetSurface: OPTI_SURFACE }).run();

    const { resolveSurfaceAccess } = h.moveSession.mock.calls[0][2];
    await expect(resolveSurfaceAccess()).resolves.toEqual({
      isAdmin: false,
      tags: ['opti'],
      entitlements: ['optihashi:pro'],
    });
  });

  it('accepts null as the main notebook list', async () => {
    await call({ targetSurface: null }).run();

    expect(h.moveSession.mock.calls[0][1]).toEqual({ id: 'session-1', targetSurface: null });
  });

  it.each([[{}], [{ targetSurface: 3 }]])('400s a body without a string-or-null targetSurface (%j)', async body => {
    await expect(call(body).run()).rejects.toBeInstanceOf(BadRequestError);
    expect(h.moveSession).not.toHaveBeenCalled();
  });

  it('400s a request with no session id', async () => {
    await expect(call({ targetSurface: null }, {}).run()).rejects.toBeInstanceOf(BadRequestError);
  });

  it('lets the service 403 surface unchanged', async () => {
    h.moveSession.mockRejectedValue(new ForbiddenError('You do not have access to that workspace'));

    await expect(call({ targetSurface: OPTI_SURFACE }).run()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
