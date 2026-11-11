import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  deleteOne: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    delete: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      mocks.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: mocks.findById, deleteOne: mocks.deleteOne },
  FeedbackTextModel: { deleteOne: vi.fn().mockResolvedValue({}) },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));

await import('../delete');

const FEEDBACK_ID = '507f1f77bcf86cd7994390fb';

const call = async (user: Record<string, unknown>, body?: unknown) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: FEEDBACK_ID }, body });
  Object.assign(req, { user, ability: { can: () => true }, logger: { error: vi.fn() } });
  await mocks.deleteHandler!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  const plain = { id: FEEDBACK_ID, userId: 'reporter1', status: 'New', type: 'Bug' };
  mocks.findById.mockResolvedValue({ ...plain, toJSON: () => plain });
  mocks.deleteOne.mockResolvedValue({ deletedCount: 1 });
  mocks.audit.mockResolvedValue({ id: 'audit1' });
});

describe('DELETE /api/feedback/[id] - admin deletes are reasoned and audited', () => {
  it('lets a reporter retract their own report with no reason and no Admin log entry', async () => {
    const res = await call({ id: 'reporter1' });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.deleteOne).toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('audits an own report deleted with a reason, as the admin dialog sends', async () => {
    await call({ id: 'reporter1', isAdmin: true }, { reason: 'Test submission' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'feedback.deleted', reason: 'Test submission' })
    );
  });

  it("refuses to delete another user's report without a reason", async () => {
    await expect(call({ id: 'admin1', isAdmin: true })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ id: 'admin1', isAdmin: true }, { reason: 'no' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.deleteOne).not.toHaveBeenCalled();
  });

  it('records the acting admin, the reason and the report in the Admin log', async () => {
    const res = await call({ id: 'admin1', isAdmin: true }, { reason: 'Duplicate report' });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.deleteOne).toHaveBeenCalledWith({ _id: FEEDBACK_ID });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'admin1' }) }),
      expect.objectContaining({
        action: 'feedback.deleted',
        target: { kind: 'user', id: 'reporter1', displayName: 'reporter1' },
        reason: 'Duplicate report',
        details: { feedbackId: FEEDBACK_ID, status: 'New', type: 'Bug' },
      })
    );
  });

  it('does not audit a deletion when the report has already disappeared', async () => {
    mocks.deleteOne.mockResolvedValue({ deletedCount: 0 });
    await expect(call({ id: 'admin1', isAdmin: true }, { reason: 'Duplicate report' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('treats an admin impersonating the reporter as an admin delete', async () => {
    await expect(call({ id: 'reporter1', impersonatedBy: 'admin1' })).rejects.toMatchObject({ statusCode: 400 });
    await call({ id: 'reporter1', impersonatedBy: 'admin1' }, { reason: 'Test submission' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'feedback.deleted' })
    );
  });

  it('fails the delete when the Admin log write fails', async () => {
    mocks.audit.mockRejectedValue(new Error('audit write failed'));
    await expect(call({ id: 'admin1', isAdmin: true }, { reason: 'Duplicate report' })).rejects.toThrow(
      'audit write failed'
    );
  });
});
