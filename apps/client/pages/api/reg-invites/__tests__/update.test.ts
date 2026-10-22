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

const run = async (ids: string[], isAdmin = true) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body: { ids, status: 'used' }, user: { id: 'admin-1', isAdmin }, ability: {} });
  await h.handler!(req, res);
  return { req, res };
};

describe('POST /api/reg-invites/update - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.formatRegInvites.mockResolvedValue([{ id: 'inv-1', status: 'used' }]);
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
        details: { ids: ['inv-1'], status: 'used' },
      })
    );
    expect(h.formatRegInvites.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('targets the invite set as a whole for a bulk update', async () => {
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
});
