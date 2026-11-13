import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  formatRegInvites: vi.fn(),
  logEvent: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => {
  let guard: (req: unknown, res: unknown, next: () => void) => void;
  const chain = {
    use: (fn: typeof guard) => {
      guard = fn;
      return chain;
    },
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = async (req: unknown, res: unknown) => {
        guard({ method: 'POST', ...(req as object) }, res, () => {});
        return fn(req, res);
      };
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  registrationInviteRepository: { formatRegInvites: h.formatRegInvites },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

await import('../update');

const ID1 = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);

const run = async (ids: unknown, isAdmin = true, fields: Record<string, unknown> = { status: 'used' }) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body: { ids, ...fields }, user: { id: 'admin-1', isAdmin }, ability: {} });
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
    const { req, res } = await run([ID1]);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.reg_invite.updated',
        target: { kind: 'settings', id: 'inv-1', displayName: 'registration invite' },
        details: { requested: 1, ids: [ID1], idsTruncated: false, status: 'used' },
      })
    );
    expect(h.formatRegInvites.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('targets the invite set as a whole for a bulk update', async () => {
    h.formatRegInvites.mockResolvedValue([{ id: 'inv-1' }, { id: 'inv-2' }]);
    await run([ID1, ID2]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { kind: 'settings', id: 'registration_invites', displayName: '2 registration invites' },
      })
    );
  });

  it('does not audit an update whose ids match no invite', async () => {
    h.formatRegInvites.mockResolvedValue([]);
    const { res } = await run([ID2]);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    const run1 = run([ID1]);
    await expect(run1).rejects.toThrow(/audit down/);
    expect(h.logEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-admin before any write', async () => {
    await expect(run([ID1], false)).rejects.toThrow('Missing permission: settings:manage');
    expect(h.formatRegInvites).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not pass ids into the update object', async () => {
    await run([ID1]);
    expect(h.formatRegInvites).toHaveBeenCalledWith({ status: 'used' }, [ID1]);
  });

  it('rejects a string ids body before any write', async () => {
    await expect(run(ID1)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.formatRegInvites).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('bounds the audited ids over the cap and sizes the target from the returned invites', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(24, '0'));
    h.formatRegInvites.mockResolvedValue(ids.map(id => ({ id })));
    await run(ids);
    const entry = h.audit.mock.calls[0][1];
    expect(entry.details.requested).toBe(150);
    expect(entry.details.ids).toHaveLength(100);
    expect(entry.details.idsTruncated).toBe(true);
    expect(entry.target.displayName).toBe('150 registration invites');
  });
});

describe('POST /api/reg-invites/update - editable fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.formatRegInvites.mockResolvedValue([{ id: ID1 }]);
    h.logEvent.mockResolvedValue(undefined);
    h.audit.mockResolvedValue(null);
  });

  it('sets unlimited use and audits it', async () => {
    const { res } = await run([ID1], true, { unlimitedUse: true });
    expect(res._getStatusCode()).toBe(200);
    expect(h.formatRegInvites).toHaveBeenCalledWith({ unlimitedUse: true }, [ID1]);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({ unlimitedUse: true, status: null });
  });

  it('sets an expiry date and clears it with null', async () => {
    await run([ID1], true, { expiresAt: '2030-01-31T23:59:59.999Z' });
    expect(h.formatRegInvites).toHaveBeenLastCalledWith({ expiresAt: new Date('2030-01-31T23:59:59.999Z') }, [ID1]);
    expect(h.audit.mock.calls[0][1].details).toMatchObject({ expiresAt: '2030-01-31T23:59:59.999Z' });

    await run([ID1], true, { expiresAt: null });
    expect(h.formatRegInvites).toHaveBeenLastCalledWith({ expiresAt: null }, [ID1]);
    expect(h.audit.mock.calls[1][1].details).toMatchObject({ expiresAt: null });
  });

  it.each([
    ['a non-boolean unlimitedUse', { unlimitedUse: 'yes' }],
    ['an unparseable expiry', { expiresAt: 'not-a-date' }],
    ['an empty-string expiry', { expiresAt: '' }],
    ['an unknown status', { status: 'disabled' }],
    ['no editable field', {}],
  ])('rejects %s before any write', async (_label, fields) => {
    await expect(run([ID1], true, fields)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.formatRegInvites).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([['inv-1'], [{ $gt: '' }], ['a'.repeat(23)]])('rejects the non-ObjectId id %j before any write', async id => {
    await expect(run([id], true, { unlimitedUse: true })).rejects.toBeInstanceOf(BadRequestError);
    expect(h.formatRegInvites).not.toHaveBeenCalled();
  });

  it.each([{ unlimitedUse: true }, { expiresAt: '2030-01-31T00:00:00.000Z' }])(
    'rejects a non-admin editing %j before any write',
    async fields => {
      await expect(run([ID1], false, fields)).rejects.toThrow('Missing permission: settings:manage');
      expect(h.formatRegInvites).not.toHaveBeenCalled();
      expect(h.audit).not.toHaveBeenCalled();
    }
  );
});
