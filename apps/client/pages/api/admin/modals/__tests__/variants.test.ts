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
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ensureAdmin: (isAdmin?: boolean) => {
    if (!isAdmin) throw new Error('forbidden');
  },
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

const run = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
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
});
