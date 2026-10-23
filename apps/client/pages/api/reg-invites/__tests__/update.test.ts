import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  formatRegInvites: vi.fn(),
  logEvent: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  registrationInviteRepository: { formatRegInvites: h.formatRegInvites },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

await import('../update');

const run = async (ids: unknown, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body: { ids, status: 'used' }, user: { id: 'admin-1', isAdmin }, ability: {} });
  await h.handler!(req, res);
  return { req, res };
};

describe('POST /api/reg-invites/update - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.formatRegInvites.mockResolvedValue([{ id: 'inv-1', status: 'used' }]);
    h.logEvent.mockResolvedValue(undefined);
    h.audit.mockResolvedValue(null);
  });

  it('records a strict .updated entry after the update', async () => {
    const { req, res } = await run(['inv-1']);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.reg_invite.updated',
        target: { kind: 'settings', id: 'inv-1', displayName: 'registration invite' },
        details: { requested: 1, ids: ['inv-1'], idsTruncated: false, status: 'used' },
      })
    );
    expect(h.formatRegInvites.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('targets the invite set as a whole for a bulk update', async () => {
    h.formatRegInvites.mockResolvedValue([{ id: 'inv-1' }, { id: 'inv-2' }]);
    await run(['inv-1', 'inv-2']);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { kind: 'system', id: 'registration_invites', displayName: '2 registration invites' },
      })
    );
  });

  it('does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    const run1 = run(['inv-1']);
    await expect(run1).rejects.toThrow(/audit down/);
    expect(h.logEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-admin before any write', async () => {
    await expect(run(['inv-1'], false)).rejects.toThrow(/permission denied/i);
    expect(h.formatRegInvites).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not pass ids into the update object', async () => {
    await run(['inv-1']);
    expect(h.formatRegInvites).toHaveBeenCalledWith({ status: 'used' }, ['inv-1']);
  });

  it('rejects a string ids body before any write', async () => {
    await expect(run('inv-1')).rejects.toThrow();
    expect(h.formatRegInvites).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('bounds the audited ids over the cap and sizes the target from the returned invites', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `inv-${i}`);
    h.formatRegInvites.mockResolvedValue(ids.map(id => ({ id })));
    await run(ids);
    const entry = h.audit.mock.calls[0][1];
    expect(entry.details.requested).toBe(150);
    expect(entry.details.ids).toHaveLength(100);
    expect(entry.details.idsTruncated).toBe(true);
    expect(entry.target.displayName).toBe('150 registration invites');
  });
});
