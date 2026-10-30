// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method: string }).method]?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: Route) => ((routes.GET = fn), chain),
        put: (fn: Route) => ((routes.PUT = fn), chain),
        delete: (fn: Route) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

const h = vi.hoisted(() => ({
  audit: vi.fn(async () => null),
  findByToolId: vi.fn(),
  updateDescription: vi.fn(),
  createOverride: vi.fn(),
  softDelete: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  toolDefinitionOverrideRepository: {
    findByToolId: h.findByToolId,
    updateDescription: h.updateDescription,
    createOverride: h.createOverride,
    softDelete: h.softDelete,
  },
}));
vi.mock('@client/app/utils/toolMapping', () => ({
  TOOL_MAPPING: { web_search: { description: 'Search the web for current information.', displayName: 'Web Search' } },
  TOOL_CATEGORIES: { web_search: 'Search' },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../[toolId]';

const TOOL_ID = 'web_search';
const BODY = {
  description: 'A replacement description that is comfortably longer than fifty characters in total.',
  shortDescription: 'Short replacement text',
  enabled: true,
};
const EXISTING = { toolId: TOOL_ID, description: 'old description', shortDescription: 'old short', enabled: false };

const invoke = async (method: 'PUT' | 'DELETE', body?: object, isAdmin = true) => {
  const { req, res } = createMocks({ method, body, query: { toolId: TOOL_ID } });
  (req as unknown as { user: { id: string; isAdmin: boolean; name: string } }).user = {
    id: 'admin-1',
    isAdmin,
    name: 'Admin',
  };
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findByToolId.mockResolvedValue(EXISTING);
  h.updateDescription.mockResolvedValue({ ...EXISTING, ...BODY });
  h.createOverride.mockResolvedValue({ toolId: TOOL_ID, ...BODY });
  h.softDelete.mockResolvedValue(undefined);
});

describe('PUT /api/admin/tool-definitions/[toolId] admin audit', () => {
  it('records override_updated with a before/after diff when updating an existing override', async () => {
    const { req, res } = await invoke('PUT', BODY);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.tool_definition.override_updated',
      target: { kind: 'settings', id: TOOL_ID },
      changes: expect.arrayContaining([{ field: 'description', before: 'old description', after: BODY.description }]),
    });
    expect(h.updateDescription.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('leaves unchanged fields out of the update diff', async () => {
    h.findByToolId.mockResolvedValue({ ...EXISTING, description: BODY.description, enabled: true });
    await invoke('PUT', BODY);

    expect(h.audit.mock.calls[0][1].changes).toEqual([
      { field: 'shortDescription', before: 'old short', after: BODY.shortDescription },
    ]);
    expect(h.updateDescription.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records override_updated when creating the first override', async () => {
    h.findByToolId.mockResolvedValue(null);
    const { res } = await invoke('PUT', BODY);

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.tool_definition.override_updated',
      target: { kind: 'settings', id: TOOL_ID },
      changes: [
        { field: 'description', before: 'Search the web for current information.', after: BODY.description },
        { field: 'shortDescription', before: 'Search the web for current information.', after: BODY.shortDescription },
      ],
    });
    expect(h.createOverride.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit an invalid body', async () => {
    const { res } = await invoke('PUT', { description: 'too short' });

    expect(res._getStatusCode()).toBe(400);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/tool-definitions/[toolId] admin audit', () => {
  it('records override_deleted after the soft delete', async () => {
    const { res } = await invoke('DELETE');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.tool_definition.override_deleted',
      target: { kind: 'settings', id: TOOL_ID },
    });
    expect(h.softDelete.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit when there is no override to delete', async () => {
    h.findByToolId.mockResolvedValue(null);
    const { res } = await invoke('DELETE');

    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('/api/admin/tool-definitions/[toolId] non-admin', () => {
  it('refuses a non-admin before touching the override', async () => {
    await expect(invoke('PUT', BODY, false)).rejects.toThrow(/missing permission/i);
    await expect(invoke('DELETE', undefined, false)).rejects.toThrow(/missing permission/i);
    expect(h.findByToolId).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
