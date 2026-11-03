import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  update: vi.fn(),
  createUser: vi.fn(),
  publish: vi.fn(),
  emitSignupFunnelEvents: vi.fn(),
  recordSyntheticIdentity: vi.fn(),
  recordAdminAction: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({ userRepository: { update: h.update } }));
vi.mock('@bike4mind/services', () => ({ userService: { createUser: h.createUser } }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/analytics/funnel', () => ({
  emitSignupFunnelEvents: (...args: unknown[]) => h.emitSignupFunnelEvents(...args),
  recordSyntheticIdentity: (...args: unknown[]) => h.recordSyntheticIdentity(...args),
}));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/mailer/emailHelpers')>()),
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));

vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => h.recordAdminAction(...args),
}));

await import('../bulk-create-users');

const makeReq = (users: unknown[]) => ({
  body: { users },
  user: { id: 'admin-1', isAdmin: true },
  ability: {},
});

describe('POST /api/admin/bulk-create-users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createUser.mockResolvedValue({ id: 'new-1', email: 'a@b.test', name: 'a@b.test', storageLimit: 1000 });
    h.recordSyntheticIdentity.mockResolvedValue(false);
    h.recordAdminAction.mockResolvedValue(null);
  });

  describe('admin audit', () => {
    const okRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

    it('records one user.bulk_created entry for the batch with the created ids and counts', async () => {
      h.createUser
        .mockResolvedValueOnce({ id: 'new-1', email: 'a@b.test', name: 'a', storageLimit: 1000 })
        .mockResolvedValueOnce({ id: 'new-2', email: 'c@b.test', name: 'c', storageLimit: 1000 });

      await h.handler!(makeReq([{ email: 'a@b.test' }, { email: 'c@b.test' }, { first: 'no-email' }]), okRes());

      expect(h.recordAdminAction).toHaveBeenCalledTimes(1);
      expect(h.recordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.bulk_created',
          target: expect.objectContaining({ kind: 'system', id: 'bulk-create-users' }),
          details: {
            count: 2,
            failedCount: 1,
            createdUserIds: expect.arrayContaining(['new-1', 'new-2']),
            credits: 0,
            startingCreditsTotal: 0,
            startingCreditsByUserId: { 'new-1': 0, 'new-2': 0 },
          },
        })
      );
    });

    it('caps the recorded user ids at the first 100', async () => {
      let next = 0;
      h.createUser.mockImplementation(async () => {
        next += 1;
        return { id: `new-${next}`, email: `u${next}@b.test`, name: 'u', storageLimit: 1000 };
      });
      const rows = Array.from({ length: 101 }, (_, index) => ({ email: `u${index}@b.test` }));

      await h.handler!(makeReq(rows), okRes());

      const { details } = h.recordAdminAction.mock.calls[0][1] as {
        details: { count: number; createdUserIds: string[] };
      };
      expect(details.count).toBe(101);
      expect(details.createdUserIds).toHaveLength(100);
    });

    it('counts a row that fails after creation in failedCount', async () => {
      h.publish.mockRejectedValueOnce(new Error('publish failed'));

      await h.handler!(makeReq([{ email: 'a@b.test' }]), okRes());

      expect(h.recordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ count: 1, failedCount: 1 }) })
      );
    });

    it.each([
      ['synthetic identity', h.recordSyntheticIdentity],
      ['signup funnel', h.emitSignupFunnelEvents],
      ['profile update', h.update],
    ] as const)('audits a persisted account and credits when %s fails', async (_step, failingOperation) => {
      failingOperation.mockRejectedValueOnce(new Error('post-creation failure'));
      const res = okRes();

      await h.handler!(makeReq([{ email: 'a@b.test', startingCredits: 50 }]), res);

      expect(h.recordAdminAction).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.bulk_created',
          details: {
            count: 1,
            failedCount: 1,
            createdUserIds: ['new-1'],
            credits: 50,
            startingCreditsTotal: 50,
            startingCreditsByUserId: { 'new-1': 50 },
          },
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        results: [{ success: false, email: 'a@b.test', error: 'post-creation failure' }],
      });
    });

    it('records nothing when account creation fails', async () => {
      h.createUser.mockRejectedValueOnce(new Error('create failed'));

      await h.handler!(makeReq([{ email: 'a@b.test', startingCredits: 50 }]), okRes());

      expect(h.recordAdminAction).not.toHaveBeenCalled();
    });

    it('records the starting credits granted, in total and per audited user', async () => {
      h.createUser
        .mockResolvedValueOnce({ id: 'new-1', email: 'a@b.test', name: 'a', storageLimit: 1000 })
        .mockResolvedValueOnce({ id: 'new-2', email: 'c@b.test', name: 'c', storageLimit: 1000 });

      await h.handler!(makeReq([{ email: 'a@b.test', startingCredits: 50 }, { email: 'c@b.test' }]), okRes());

      const { details } = h.recordAdminAction.mock.calls[0][1] as {
        details: { credits: number; startingCreditsTotal: number; startingCreditsByUserId: Record<string, number> };
      };
      expect(details.startingCreditsTotal).toBe(50);
      expect(details.credits).toBe(details.startingCreditsTotal);
      expect(details.startingCreditsByUserId).toEqual({ 'new-1': 50, 'new-2': 0 });
    });

    it('records nothing when no row was created', async () => {
      await h.handler!(makeReq([{ first: 'no-email' }]), okRes());

      expect(h.recordAdminAction).not.toHaveBeenCalled();
    });

    it('records the batch best-effort, since the rows and invites cannot be rolled back', () => {
      expect(ADMIN_AUDIT_CATALOGUE['user.bulk_created'].write).toBe('bestEffort');
    });
  });

  it('resolves storage during creation and writes tags separately', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test', startingStorage: 5000, tags: ['x', 'y'] }]), res);

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ record: expect.objectContaining({ storageLimit: 5000 }) }),
      expect.anything()
    );
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'new-1', tags: ['x', 'y'] });
    expect(h.emitSignupFunnelEvents).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'new-1', isSynthetic: false }),
      method: 'admin',
      emailVerified: false,
      creditsGranted: 0,
    });
  });

  it('passes a synthetic classification into the signup emitter', async () => {
    const user = { id: 'new-synthetic', email: 'seed@test.example', name: 'Seed', storageLimit: 1000 };
    h.createUser.mockResolvedValue(user);
    h.recordSyntheticIdentity.mockResolvedValue(true);

    await h.handler!(makeReq([{ email: 'seed@test.example' }]), {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    expect(h.recordSyntheticIdentity).toHaveBeenCalledWith(user);
    expect(h.emitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'new-synthetic', isSynthetic: true }) })
    );
  });

  it('writes the created defaults, with tags undefined, when neither is given', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test' }]), res);

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'new-1', tags: undefined });
  });

  it('reports an invalid row as a per-row failure without failing the batch', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test' }, { first: 'no-email' }]), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const { results } = json.mock.calls[0][0];
    expect(results[0]).toMatchObject({ success: true, email: 'a@b.test' });
    expect(results[1]).toMatchObject({ success: false, error: expect.any(String) });
  });

  it('escapes the user name in the welcome email body', async () => {
    h.createUser.mockResolvedValue({ id: 'new-1', email: 'a@b.test', name: '<b>x</b>', storageLimit: 1000 });

    await h.handler!(makeReq([{ email: 'a@b.test', first: '<b>x</b>' }]), {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    const { body } = h.publish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(body).not.toContain('<b>x</b>');
  });

  it('derives a username that satisfies the username rules from the address', async () => {
    await h.handler!(makeReq([{ email: 'first.last+tag@b.test' }]), {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    expect(h.createUser.mock.calls[0][0].username).toBe('first.lasttag');
  });

  it('falls back to a generated username when the local part has no usable characters', async () => {
    await h.handler!(makeReq([{ email: '+++@b.test' }]), { status: vi.fn().mockReturnThis(), json: vi.fn() });

    expect(h.createUser.mock.calls[0][0].username).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it('never derives the reserved test-persona prefix from an address', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await h.handler!(makeReq([{ email: 'persona-jo@b.test' }, { email: 'Persona-@b.test' }]), res);

    const usernames = h.createUser.mock.calls.map(([params]) => params.username);
    expect(usernames).toContain('jo');
    expect(usernames.find(u => u !== 'jo')).toMatch(/^user-[0-9a-f]{8}$/);
    expect(h.createUser.mock.calls.every(([params]) => params.allowReservedUsername === undefined)).toBe(true);
  });
});
