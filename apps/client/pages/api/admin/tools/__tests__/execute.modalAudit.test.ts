import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Real execute handler, admin tool service, modal tool server, modalOperations and
// collectModalChanges: only the database and request plumbing are mocked, so this
// covers the AsyncLocalStorage chain from noteModalChange through recordModalChanges.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    return chain;
  },
}));

const model = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findByIdAndDelete: vi.fn(),
}));
vi.mock('@bike4mind/database/social', () => ({ ModalModel: model }));
vi.mock('@client/pages/api/admin/modal-tool', () => ({ parseNaturalLanguageQueryDirect: vi.fn() }));
vi.mock('@client/server/tools/modalImageHandler', () => ({
  ModalImageHandler: { processModalImageUrl: vi.fn() },
}));
vi.mock('@server/utils/cacheExternalImage', () => ({ cacheExternalImage: vi.fn() }));

const mockAudit = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: (...a: unknown[]) => mockAudit(...a) }));

import handler from '../execute';

const MODAL_ID = '64b7f0c2a1b2c3d4e5f60718';

function call(body: object) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as { user: object }).user = { isAdmin: true, id: 'admin-1', permissions: ['manage_modals'] };
  return (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res).then(() => res);
}

describe('POST /api/admin/tools/execute modal audit (real tool chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAudit.mockResolvedValue(null);
    model.findById.mockReturnValue({ lean: async () => ({ _id: MODAL_ID, title: 'Welcome', tags: [] }) });
  });

  it('audits a modal create as settings.modal.created via admin-tool', async () => {
    model.create.mockResolvedValue({ _id: MODAL_ID, title: 'Welcome' });

    const res = await call({ tool: 'modal', params: { action: 'create', data: { title: 'Welcome' } } });

    expect((res as { _getJSONData(): { success: boolean } })._getJSONData().success).toBe(true);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.created',
      target: { kind: 'settings', id: MODAL_ID, displayName: 'Welcome' },
      details: { via: 'admin-tool' },
    });
  });

  it('audits a modal delete as settings.modal.deleted via admin-tool', async () => {
    model.findByIdAndDelete.mockResolvedValue({ _id: MODAL_ID, title: 'Welcome' });

    await call({ tool: 'modal', params: { action: 'delete', data: { id: MODAL_ID } } });

    expect(mockAudit.mock.calls.map(c => c[1])).toEqual([
      expect.objectContaining({ action: 'settings.modal.deleted', details: { via: 'admin-tool' } }),
    ]);
  });

  it('audits a modal update as settings.modal.updated via admin-tool', async () => {
    model.findById.mockResolvedValue({ _id: MODAL_ID, title: 'Welcome', tags: [] });
    model.findByIdAndUpdate.mockResolvedValue({ _id: MODAL_ID, title: 'Welcome back' });

    await call({ tool: 'modal', params: { action: 'update', data: { id: MODAL_ID, enabled: true } } });

    expect(mockAudit.mock.calls.map(c => c[1])).toEqual([
      expect.objectContaining({
        action: 'settings.modal.updated',
        target: expect.objectContaining({ id: MODAL_ID }),
        details: { via: 'admin-tool' },
      }),
    ]);
  });

  it('audits nothing when the modal tool only reads', async () => {
    model.findById.mockReturnValue({ lean: async () => null });
    await call({ tool: 'modal', params: { action: 'help' } });

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
