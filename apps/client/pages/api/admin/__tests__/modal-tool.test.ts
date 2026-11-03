// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  createModal: vi.fn(),
  updateModal: vi.fn(),
  audit: vi.fn(),
  changes: [] as Array<{ kind: string; id: string; title: string }>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res),
      { post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));
// No operations model available, so the route uses its pattern-matching fallback.
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: () => {
      throw new Error('no model');
    },
  },
}));
vi.mock('@client/server/tools/modalOperations', () => ({
  collectModalChanges: async (run: () => Promise<unknown>) => ({ result: await run(), changes: h.changes }),
  createModal: h.createModal,
  updateModal: h.updateModal,
  listModals: vi.fn(),
  deleteModal: vi.fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../modal-tool';

const post = async (query: string) => {
  const { req, res } = createMocks({ method: 'POST', body: { query } });
  Object.assign(req, { ability: { can: () => true }, user: { id: 'admin-1', isAdmin: true } });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.changes.length = 0;
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/modal-tool admin audit', () => {
  it('records modal.created for each modal the tool created', async () => {
    h.createModal.mockImplementation(async () => {
      h.changes.push({ kind: 'created', id: 'm1', title: 'Hello banner' });
      return { success: true, message: 'Banner created successfully' };
    });
    const { req, res } = await post('create a banner saying hello');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.created',
      target: { kind: 'settings', id: 'm1', displayName: 'Hello banner' },
    });
  });

  it('records modal.updated when the tool updated a modal', async () => {
    h.updateModal.mockImplementation(async () => {
      h.changes.push({ kind: 'updated', id: 'm2', title: 'Welcome' });
      return { success: true, message: 'ok' };
    });
    await post('enable the Welcome modal');

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.updated',
      target: { kind: 'settings', id: 'm2' },
    });
  });

  it('records nothing when the operation failed to write', async () => {
    h.createModal.mockResolvedValue({ success: false, error: 'boom' });
    await post('create a banner saying hello');

    expect(h.audit).not.toHaveBeenCalled();
  });
});
