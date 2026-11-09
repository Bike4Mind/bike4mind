import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  update: vi.fn(),
  createUser: vi.fn(),
  publish: vi.fn(),
  emitSignupFunnelEvents: vi.fn(),
  recordAccountLane: vi.fn(),
  recordAdminAction: vi.fn(),
  requirePackage: vi.fn(),
  reserve: vi.fn(),
  claim: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  userRepository: { update: h.update, claimFreeCreditGrant: h.claim },
  grantPackageRepository: { reserveRedemption: h.reserve },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  userService: { createUser: h.createUser },
  referService: { requireActiveGrantPackage: h.requirePackage },
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/analytics/funnel', () => ({
  emitSignupFunnelEvents: (...args: unknown[]) => h.emitSignupFunnelEvents(...args),
  recordAccountLane: (...args: unknown[]) => h.recordAccountLane(...args),
}));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/mailer/emailHelpers')>()),
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));

vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => h.recordAdminAction(...args),
}));

await import('../bulk-create-users');

const makeReq = (users: unknown[], extra: Record<string, unknown> = {}) => ({
  body: { users, ...extra },
  user: { id: 'admin-1', isAdmin: true },
  ability: {},
});

describe('POST /api/admin/bulk-create-users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createUser.mockResolvedValue({ id: 'new-1', email: 'a@b.test', name: 'a@b.test', storageLimit: 1000 });
    h.recordAccountLane.mockResolvedValue({ isSynthetic: false, isInternal: false });
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
            grantPackageId: null,
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
      ['account lane', h.recordAccountLane],
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
            grantPackageId: null,
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
    h.recordAccountLane.mockResolvedValue({ isSynthetic: true, isInternal: false });

    await h.handler!(makeReq([{ email: 'seed@test.example' }]), {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    expect(h.recordAccountLane).toHaveBeenCalledWith(user);
    expect(h.emitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'new-synthetic', isSynthetic: true }) })
    );
  });

  it('passes an internal classification into the signup emitter', async () => {
    const user = { id: 'new-staff', email: 'a@staff.example', name: 'Staff', storageLimit: 1000 };
    h.createUser.mockResolvedValue(user);
    h.recordAccountLane.mockResolvedValue({ isSynthetic: false, isInternal: true });

    await h.handler!(makeReq([{ email: 'a@staff.example' }]), {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    expect(h.recordAccountLane).toHaveBeenCalledWith(user);
    expect(h.emitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'new-staff', isSynthetic: false, isInternal: true }),
      })
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

  describe('grant package', () => {
    const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
    const pkg = { id: 'pkg-1', credits: 250, storageMb: 400, active: true };
    beforeEach(() => {
      h.claim.mockResolvedValue(true);
    });

    it('creates each row with the package amounts and reserves one redemption per account', async () => {
      h.requirePackage.mockResolvedValue(pkg);
      h.reserve.mockResolvedValue({ outcome: 'reserved', release: vi.fn() });
      await h.handler!(makeReq([{ email: 'a@b.test', startingCredits: 9 }], { grantPackageId: 'pkg-1' }), res());
      expect(h.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ initialCredits: 250, record: expect.objectContaining({ storageLimit: 400 }) }),
        expect.anything()
      );
      expect(h.reserve).toHaveBeenCalledWith('pkg-1', 'new-1');
    });

    it('stamps the package on the user, merges package and row tags, and audits the package', async () => {
      h.requirePackage.mockResolvedValue({ ...pkg, tags: ['promo', 'x'] });
      h.reserve.mockResolvedValue({ outcome: 'reserved', release: vi.fn() });
      await h.handler!(makeReq([{ email: 'a@b.test', tags: ['x', 'y'] }], { grantPackageId: 'pkg-1' }), res());
      expect(h.update).toHaveBeenCalledWith({ id: 'new-1', grantPackageId: 'pkg-1' });
      expect(h.update).toHaveBeenLastCalledWith({ id: 'new-1', tags: ['promo', 'x', 'y'] });
      expect(h.recordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ grantPackageId: 'pkg-1' }) })
      );
    });

    it('never stamps the package on a row the caps refused', async () => {
      h.requirePackage.mockResolvedValue(pkg);
      h.reserve.mockResolvedValue({ outcome: 'refused', reason: 'daily_cap' });
      await h.handler!(makeReq([{ email: 'a@b.test' }], { grantPackageId: 'pkg-1' }), res());
      expect(h.update).not.toHaveBeenCalledWith(expect.objectContaining({ grantPackageId: 'pkg-1' }));
    });

    it('fails a row whose inbox already took a package grant', async () => {
      h.requirePackage.mockResolvedValue(pkg);
      h.createUser
        .mockResolvedValueOnce({ id: 'new-1', email: 'a@b.test', name: 'a' })
        .mockResolvedValueOnce({ id: 'new-2', email: 'a+1@b.test', name: 'a' });
      h.reserve.mockResolvedValue({ outcome: 'reserved', release: vi.fn() });
      h.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const r = res();
      await h.handler!(makeReq([{ email: 'a@b.test' }, { email: 'a+1@b.test' }], { grantPackageId: 'pkg-1' }), r);
      const { results } = r.json.mock.calls[0][0] as { results: { success: boolean; error?: string }[] };
      expect(results.map(row => row.success)).toEqual([true, false]);
      expect(results[1].error).toBe('This inbox has already received a signup grant');
      expect(h.reserve).toHaveBeenCalledTimes(1);
    });

    it('reports a capped row as a failure without failing the batch', async () => {
      h.requirePackage.mockResolvedValue(pkg);
      h.createUser
        .mockResolvedValueOnce({ id: 'new-1', email: 'a@b.test', name: 'a' })
        .mockResolvedValueOnce({ id: 'new-2', email: 'c@b.test', name: 'c' });
      h.reserve
        .mockResolvedValueOnce({ outcome: 'reserved', release: vi.fn() })
        .mockResolvedValueOnce({ outcome: 'refused', reason: 'total_cap' });
      const r = res();
      await h.handler!(makeReq([{ email: 'a@b.test' }, { email: 'c@b.test' }], { grantPackageId: 'pkg-1' }), r);
      const { results } = r.json.mock.calls[0][0] as { results: { success: boolean; error?: string }[] };
      expect(results.map(row => row.success)).toEqual([true, false]);
      expect(results[1].error).toBe('This invite code has reached its signup limit');
      expect(h.publish).toHaveBeenCalledTimes(1);
    });

    it('rejects the batch before creating anyone when the package is unknown or inactive', async () => {
      h.requirePackage.mockRejectedValue(new Error('Grant package is inactive'));
      await expect(h.handler!(makeReq([{ email: 'a@b.test' }], { grantPackageId: 'pkg-1' }), res())).rejects.toThrow(
        'Grant package is inactive'
      );
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it('rejects an empty package id', async () => {
      await expect(h.handler!(makeReq([{ email: 'a@b.test' }], { grantPackageId: '' }), res())).rejects.toThrow(
        'Invalid grant package id'
      );
      expect(h.createUser).not.toHaveBeenCalled();
    });
  });
});
