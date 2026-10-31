// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Fn = (req: unknown, res: unknown, next: () => void) => unknown;
    const routes: Record<string, Fn> = {};
    const middlewares: Fn[] = [];
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        for (const mw of middlewares) {
          let proceeded = false;
          await mw(req, res, () => {
            proceeded = true;
          });
          if (!proceeded) return;
        }
        return routes[req.method ?? 'GET']?.(req, res, () => undefined);
      },
      {
        use: (fn: Fn) => (middlewares.push(fn), chain),
        get: (fn: Fn) => ((routes.GET = fn), chain),
        put: (fn: Fn) => ((routes.PUT = fn), chain),
        delete: (fn: Fn) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
  BadRequestError: class BadRequestError extends Error {},
  isZodError: () => false,
}));
vi.mock('@bike4mind/services', () => ({
  MODAL_AUDIENCE_KEY_SET: new Set(['customer', 'internal']),
  MODAL_SAFE_DEFAULT_KEY: 'customer',
}));
vi.mock('@bike4mind/database/social', () => ({
  ModalModel: {
    findById: (id: string) => ({ lean: () => h.findById(id) }),
    findByIdAndUpdate: (...args: unknown[]) => ({ lean: () => h.findByIdAndUpdate(...args) }),
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../variants';

type TestUser = { id: string; isAdmin?: boolean; adminPermissions?: string[] };
const FULL_ADMIN: TestUser = { id: 'admin-1', isAdmin: true };

const run = async (method: 'GET' | 'PUT' | 'DELETE', body: Record<string, unknown>, user: TestUser = FULL_ADMIN) => {
  const { req, res } = createMocks({ method, body, query: method === 'GET' ? body : {} });
  (req as unknown as Record<string, unknown>).user = user;
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('PUT /api/admin/modals/variants admin audit', () => {
  it('records variants_updated with the audience keys, not the variant text', async () => {
    h.findByIdAndUpdate.mockResolvedValue({ _id: 'modal-1', title: 'Welcome' });
    const { req, res } = await run('PUT', {
      modalId: 'modal-1',
      variants: { customer: { title: 'Welcome' }, internal: { title: 'Internal only' } },
    });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.variants_updated',
      target: { kind: 'settings', id: 'modal-1', displayName: 'Welcome' },
      details: { audienceKeys: ['customer', 'internal'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('Internal only');
  });

  it('records nothing when the modal does not exist', async () => {
    h.findByIdAndUpdate.mockResolvedValue(null);
    await run('PUT', { modalId: 'missing', variants: { customer: { title: 'x' } } }).catch(() => undefined);

    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/modals/variants admin audit', () => {
  it('records variants_cleared and notes that content was reset for an internal-only modal', async () => {
    h.findById.mockResolvedValue({
      _id: 'modal-1',
      title: 'Internal launch',
      variants: { internal: { title: 'secret' } },
    });
    h.findByIdAndUpdate.mockResolvedValue({ _id: 'modal-1', title: '', textMessage: 'Banner text' });
    const { res } = await run('DELETE', { modalId: 'modal-1' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.variants_cleared',
      target: { kind: 'settings', id: 'modal-1', displayName: 'Internal launch' },
      details: { clearedAudienceKeys: ['internal'], contentFieldsReset: true },
    });
  });

  it('records nothing when the modal had no variants to clear', async () => {
    h.findById.mockResolvedValue({ _id: 'modal-1', title: 'Welcome' });
    h.findByIdAndUpdate.mockResolvedValue({ _id: 'modal-1', title: 'Welcome' });
    const { res } = await run('DELETE', { modalId: 'modal-1' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('/api/admin/modals/variants permission gate', () => {
  const delegate: TestUser = { id: 'd-1', isAdmin: false, adminPermissions: ['settings:manage'] };
  const wrongPermission: TestUser = { id: 'd-2', isAdmin: false, adminPermissions: ['support:read'] };
  const nobody: TestUser = { id: 'u-1', isAdmin: false };
  const emptyGrant: TestUser = { id: 'u-2', isAdmin: false, adminPermissions: [] };
  const body = { modalId: 'modal-1', variants: { customer: { title: 'Welcome' } } };

  it.each([
    ['delegate with settings:manage', delegate],
    ['full admin', FULL_ADMIN],
  ])('allows %s to read, write and clear variants', async (_label, user) => {
    h.findById.mockResolvedValue({ _id: 'modal-1', title: 'Welcome', variants: { customer: { title: 'Welcome' } } });
    h.findByIdAndUpdate.mockResolvedValue({ _id: 'modal-1', title: 'Welcome' });

    expect((await run('GET', { modalId: 'modal-1' }, user)).res._getStatusCode()).toBe(200);
    expect((await run('PUT', body, user)).res._getStatusCode()).toBe(200);
    expect((await run('DELETE', { modalId: 'modal-1' }, user)).res._getStatusCode()).toBe(200);
  });

  it.each([
    ['a delegate holding a different permission', wrongPermission],
    ['a user with no admin access', nobody],
    ['a user with an empty grant list', emptyGrant],
  ])('rejects %s on every method without touching the modal', async (_label, user) => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      await expect(run(method, method === 'PUT' ? body : { modalId: 'modal-1' }, user)).rejects.toThrow(
        'Missing permission: settings:manage'
      );
    }
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
