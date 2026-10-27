import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findOneAndUpdate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    delete: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({ Subscriber: { findOneAndUpdate: h.findOneAndUpdate } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

await import('../delete');

const run = async () => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'sub-1' } });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  await h.handler!(req, res);
  return { req, res };
};

describe('DELETE /api/subscribers/[id]/delete - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.audit.mockResolvedValue(null);
  });

  it('records a best-effort .deleted entry after the soft delete', async () => {
    h.findOneAndUpdate.mockResolvedValue({ id: 'sub-1', email: 'jane@example.test' });
    const { req, res } = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.waitlist_subscriber.deleted',
        target: { kind: 'settings', id: 'sub-1', displayName: 'jane@example.test' },
      })
    );
    expect(h.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('only matches subscribers that are not already deleted', async () => {
    h.findOneAndUpdate.mockResolvedValue({ id: 'sub-1', email: 'jane@example.test' });
    await run();
    expect(h.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'sub-1', deletedAt: null });
  });

  it('does not audit a missing subscriber', async () => {
    h.findOneAndUpdate.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/not found/i);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
