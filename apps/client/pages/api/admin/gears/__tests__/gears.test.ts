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
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  gearOverrideRepository: { byKey: vi.fn() },
  GearOverride: {
    findOne: () => ({ lean: () => h.findOne() }),
    findOneAndUpdate: () => ({ lean: () => h.findOneAndUpdate() }),
    deleteOne: h.deleteOne,
  },
}));
vi.mock('@client/lib/gears/presentation', () => ({ GEAR_PRESENTATION: {} }));
vi.mock('@server/services/gears/catalog', () => ({
  GEAR_DEFAULTS: [{ key: 'daily', kind: 'reward', credits: 10 }],
  GEAR_CREDITS_SCALE: 1,
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import indexHandler from '../index';
import keyHandler from '../[key]';

const invoke = async (
  handler: unknown,
  options: { method: 'PUT' | 'DELETE'; body?: object; query?: Record<string, string> }
) => {
  const { req, res } = createMocks({ method: options.method, body: options.body, query: options.query });
  (req as unknown as { user: { id: string; isAdmin: boolean } }).user = { id: 'admin-1', isAdmin: true };
  await (handler as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findOne.mockResolvedValue({ key: 'daily', credits: 10 });
  h.findOneAndUpdate.mockResolvedValue({ key: 'daily', credits: 0 });
  h.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

describe('PUT /api/admin/gears admin audit', () => {
  it('records a gear_override.updated entry with the per-field diff', async () => {
    const { req, res } = await invoke(indexHandler, { method: 'PUT', body: { key: 'daily', credits: 0 } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.gear_override.updated',
      target: { kind: 'settings', id: 'daily' },
      changes: [{ field: 'daily.credits', before: 10, after: 0 }],
    });
    expect(h.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('leaves submitted fields whose value did not change out of the diff', async () => {
    await invoke(indexHandler, { method: 'PUT', body: { key: 'daily', credits: 10, enabled: false } });

    expect(h.audit.mock.calls[0][1].changes).toEqual([{ field: 'daily.enabled', before: null, after: false }]);
  });

  it('does not audit an unknown gear', async () => {
    const { res } = await invoke(indexHandler, { method: 'PUT', body: { key: 'ghost', credits: 0 } });

    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/gears/[key] admin audit', () => {
  it('records a gear_override.deleted entry after the delete', async () => {
    const { res } = await invoke(keyHandler, { method: 'DELETE', query: { key: 'daily' } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.gear_override.deleted',
      target: { kind: 'settings', id: 'daily' },
    });
    expect(h.deleteOne.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit when no override existed', async () => {
    h.deleteOne.mockResolvedValue({ deletedCount: 0 });
    await invoke(keyHandler, { method: 'DELETE', query: { key: 'daily' } });

    expect(h.audit).not.toHaveBeenCalled();
  });
});
