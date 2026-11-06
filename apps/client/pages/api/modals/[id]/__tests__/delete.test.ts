import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const audit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: audit,
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain,
// matching the repo's handler-test convention.
const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  modal: null as any,
  findOneAndDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: {
    findOneAndDelete: (...args: unknown[]) => mockRefs.findOneAndDelete(...args),
  },
}));

import '@pages/api/modals/[id]/delete';

const MODAL_ID = '507f1f77bcf86cd799439011';

function mocks(id = MODAL_ID) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id } });
  (req as any).ability = { can: () => true };
  return { req, res };
}

describe('DELETE /api/modals/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(null);
    mockRefs.findOneAndDelete.mockImplementation(async () => mockRefs.modal);
  });
  it('deletes the modal and returns it', async () => {
    mockRefs.modal = { _id: MODAL_ID, title: 'Demo', tags: ['whats-new'] };
    const { req, res } = mocks();

    await mockRefs.deleteHandler!(req, res);

    expect(mockRefs.findOneAndDelete).toHaveBeenCalledWith({ _id: MODAL_ID });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(mockRefs.modal);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0][0]).toBe(req);
    expect(audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.deleted',
      target: { kind: 'settings', id: MODAL_ID, displayName: 'Demo' },
      details: { via: 'admin-modals' },
    });
    expect(mockRefs.findOneAndDelete.mock.invocationCallOrder[0]).toBeLessThan(audit.mock.invocationCallOrder[0]);
  });

  it.each(['database failure', 'missing modal', 'permission denied'])('records nothing after %s', async failure => {
    const { req, res } = mocks();
    if (failure === 'database failure') mockRefs.findOneAndDelete.mockRejectedValueOnce(new Error('write failed'));
    if (failure === 'missing modal') mockRefs.findOneAndDelete.mockResolvedValueOnce(null);
    if (failure === 'permission denied') Object.assign(req, { ability: { can: () => false } });

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow();

    expect(audit).not.toHaveBeenCalled();
  });

  it('404s a malformed id instead of letting the cast throw', async () => {
    mockRefs.findOneAndDelete.mockClear();
    const { req, res } = mocks('not-an-object-id');

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('Modal not found');
    expect(mockRefs.findOneAndDelete).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
