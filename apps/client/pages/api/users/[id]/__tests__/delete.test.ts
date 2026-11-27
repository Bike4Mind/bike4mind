import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const m = vi.hoisted(() => ({
  users: {} as Record<string, unknown>,
  record: vi.fn(),
  deny: vi.fn(),
  requestErasure: vi.fn(),
  sendToQueue: vi.fn(),
  policy: vi.fn(),
  requestApproval: vi.fn(),
  publish: vi.fn(),
  slack: vi.fn(),
  settings: vi.fn(),
  erasureState: vi.fn(),
  stepUp: vi.fn(),
}));

const route = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  guards: [] as ((req: unknown, res: unknown, next: () => void) => void)[],
}));
// adminApi and csrfProtection stay real: the guards they install are part of what is under test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: Record<string, unknown>) => {
    route.options = options;
    const chain = {
      use: (guard: (req: unknown, res: unknown, next: () => void) => void) => {
        route.guards.push(guard);
        return chain;
      },
      delete: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return chain;
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: (...a: unknown[]) => m.stepUp(...a) }));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: m.slack }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: m.publish } } }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: m.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: (name: string) => `queue:${name}` }));
vi.mock('@bike4mind/server-utils/auth/adminRoles', () => ({ resolveRoleAdminPermissions: async (u: unknown) => u }));
vi.mock('@server/admin/approvals/service', () => ({
  getApprovalPolicy: () => m.policy(),
  requestApproval: (...a: unknown[]) => m.requestApproval(...a),
}));
vi.mock('@server/users/accountDeletion', () => ({ requestAdminErasure: (...a: unknown[]) => m.requestErasure(...a) }));
vi.mock('@server/dataSubject/adminErasure', () => ({
  readAdminErasureState: (...a: unknown[]) => m.erasureState(...a),
}));
vi.mock('@bike4mind/services', () => ({ adminAuditService: {} }));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: {},
  userRepository: { findById: async (id: string) => m.users[id] ?? null },
  adminSettingsRepository: {
    findBySettingNames: () => m.settings(),
    findAllByTag: async () => [{ settingValue: 'feedback@example.com' }],
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => m.record(...a),
    denySelfAdminAction: (...a: unknown[]) => m.deny(...a),
  };
});

import { ApiKeyScope, STEP_UP_REQUIRED_CODE, USER_SECRET_FIELDS, ForbiddenError } from '@bike4mind/common';
import handler from '../delete';
import { executeApprovedAdminDelete } from '@server/admin/deleteUserAsAdmin';

type Actor = { id: string; isAdmin: boolean; adminPermissions?: string[] };
const NO_SUBS = { canceled: [], failed: [] };

async function run(
  options: {
    user?: Actor;
    storedActor?: Actor | null;
    body?: unknown;
    id?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const user = options.user ?? { id: 'admin1', isAdmin: true };
  if ('storedActor' in options) m.users[user.id] = options.storedActor;
  else m.users[user.id] ??= user;
  const { req, res } = createMocks({
    method: 'DELETE',
    query: { id: options.id ?? 'u1' },
    // A first-party bearer JWT with no session cookie passes CSRF; the CSRF test overrides it.
    headers: options.headers ?? { authorization: 'Bearer a.b.c' },
  });
  req.body = 'body' in options ? options.body : { reason: 'Confirmed duplicate account' };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(req, { user, logger });
  const call = (async () => {
    for (const guard of route.guards) guard(req, res, () => {});
    return (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  })();
  return { res, call, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.users = { admin1: { id: 'admin1', isAdmin: true }, u1: { id: 'u1', name: 'Target', email: 't@example.com' } };
  m.policy.mockResolvedValue({ enabled: false, expiryHours: 24 });
  m.requestApproval.mockResolvedValue({ approvalId: 'appr1', status: 'pending', expiresAt: 'later' });
  m.erasureState.mockResolvedValue({ state: 'none', ownedOrganizations: [] });
  m.record.mockResolvedValue(null);
  m.sendToQueue.mockResolvedValue(undefined);
  m.settings.mockResolvedValue([false, false]);
  m.stepUp.mockResolvedValue(undefined);
  // Stands in for the stamp transaction: runs the hook, as lockDownAccount does, then answers.
  m.requestErasure.mockImplementation(
    async (_req: unknown, _id: string, _now: Date, opts: { recordInTransaction: () => Promise<void> }) => {
      await opts.recordInTransaction();
      return { deletion: { source: 'admin' }, subscriptions: NO_SUBS };
    }
  );
  m.deny.mockImplementation(async () => {
    throw new ForbiddenError('Admins cannot perform this action on their own account.');
  });
});

describe('DELETE /api/users/[id]/delete', () => {
  it('stamps an admin erasure, audits user.deleted with the reason, and queues the purge', async () => {
    const { res, call } = await run();
    await call;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'u1', queued: true });
    expect(m.requestErasure).toHaveBeenCalledWith(expect.anything(), 'u1', expect.any(Date), expect.anything());
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.deleted', reason: 'Confirmed duplicate account' })
    );
    expect(m.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: 'u1' });
  });

  it('uses the stored canonical ID for erasure, audit and queue payloads', async () => {
    const canonicalId = 'abcdef0123456789abcdef01';
    const alias = canonicalId.toUpperCase();
    const target = { id: canonicalId, name: 'Target' };
    m.users[canonicalId] = target;
    m.users[alias] = target;

    const { call } = await run({ id: alias });
    await call;

    expect(m.requestErasure).toHaveBeenCalledWith(expect.anything(), canonicalId, expect.any(Date), expect.anything());
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: expect.objectContaining({ id: canonicalId }) })
    );
    expect(m.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: canonicalId });
  });

  it.each([
    { label: 'revoked', storedActor: { id: 'admin1', isAdmin: false } },
    { label: 'missing', storedActor: null },
  ])(
    'rejects a $label stored actor even when the authenticated snapshot still has permission',
    async ({ storedActor }) => {
      const { call } = await run({ storedActor });

      await expect(call).rejects.toMatchObject({ statusCode: 401 });
      expect(m.requestErasure).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
      expect(m.sendToQueue).not.toHaveBeenCalled();
    }
  );

  it('records user.deleted inside the stamp transaction, so an audit failure leaves nothing queued', async () => {
    m.record.mockRejectedValue(new Error('audit down'));
    const { call } = await run();

    await expect(call).rejects.toThrow('audit down');
    expect(m.sendToQueue).not.toHaveBeenCalled();
  });

  it('answers 200 with queued:false when the queue is unreachable, leaving the sweep to run it', async () => {
    m.sendToQueue.mockRejectedValue(new Error('sqs down'));
    const { res, call, logger } = await run();
    await call;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ queued: false });
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([
    ['an owner of a shared organization', 'ACCOUNT_DELETION_ORG_OWNER'],
    ['an account with a deletion already pending', 'ALREADY_PENDING'],
  ])('answers 409 for %s and queues nothing', async (_label, code) => {
    const { ConflictError } = await import('@bike4mind/common');
    m.requestErasure.mockRejectedValue(new ConflictError('refused', { code }));
    const { call } = await run();

    await expect(call).rejects.toMatchObject({ statusCode: 409 });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sendToQueue).not.toHaveBeenCalled();
  });

  it('records the subscription cancellation on its own entry', async () => {
    m.requestErasure.mockResolvedValue({
      deletion: { source: 'admin' },
      subscriptions: { canceled: ['sub_1'], failed: [] },
    });
    const { res, call } = await run();
    await call;

    expect(res._getJSONData()).toMatchObject({ subscriptionCancellation: { canceled: ['sub_1'] } });
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.subscriptions.canceled', reason: 'Confirmed duplicate account' })
    );
  });

  it('lets a full admin delete an admin target with approvals off, with no in-transaction role check', async () => {
    m.users.u1 = { id: 'u1', name: 'Other Admin', isAdmin: true };
    const { res, call } = await run();
    await call;

    expect(res._getStatusCode()).toBe(200);
    expect(m.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'user.deleted' }));
    expect(m.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: 'u1' });
  });

  it('still answers 200 and queues the purge when the cancellation audit write fails', async () => {
    m.requestErasure.mockImplementation(
      async (_r: unknown, _id: string, _n: Date, opts: { recordInTransaction: () => Promise<void> }) => {
        await opts.recordInTransaction();
        return { deletion: {}, subscriptions: { canceled: ['sub_1'], failed: [] } };
      }
    );
    m.record.mockImplementation(async (_req: unknown, entry: { action: string }) => {
      if (entry.action === 'user.subscriptions.canceled') throw new Error('audit down');
      return null;
    });
    const { res, call, logger } = await run();
    await call;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ queued: true });
    expect(logger.error).toHaveBeenCalled();
    expect(m.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: 'u1' });
  });

  it('sends the escaped admin notifications when enabled, and a failure there does not fail the delete', async () => {
    m.users.u1 = { id: 'u1', name: '<b>Tgt</b>', email: 't@example.com' };
    m.settings.mockResolvedValue([true, true]);
    m.slack.mockRejectedValue(new Error('slack down'));
    const { res, call } = await run();
    await call;
    expect(res._getStatusCode()).toBe(200);
    expect(m.sendToQueue).toHaveBeenCalled();

    m.slack.mockResolvedValue(undefined);
    const second = await run();
    await second.call;
    const { body } = m.publish.mock.calls[0][0] as { body: string };
    expect(body).toContain('&lt;b&gt;Tgt&lt;/b&gt;');
    expect(body).not.toContain('<b>Tgt');
  });

  it('returns the serialized user shape with none of the USER_SECRET_FIELDS', async () => {
    m.users.u1 = {
      id: 'u1',
      name: 'N',
      email: 'n@example.com',
      ...Object.fromEntries(USER_SECRET_FIELDS.map(f => [f, 'x'])),
    };
    const { res, call } = await run();
    await call;

    const body = res._getJSONData();
    expect(body).toMatchObject({ id: 'u1', name: 'N' });
    expect(body).not.toHaveProperty('email');
    for (const f of USER_SECRET_FIELDS) expect(body).not.toHaveProperty(f);
  });

  describe('access', () => {
    it('is gated on users:delete for the DELETE method, JWT only with the admin scope, like erasure', () => {
      expect(route.options).toMatchObject({
        allowedMethods: ['DELETE'],
        auth: 'jwtOnly',
        requiredScopes: [ApiKeyScope.ADMIN],
      });
    });

    it('rejects an API key without the admin scope with 403 before any write', async () => {
      const { req, res } = createMocks({ method: 'DELETE', query: { id: 'u1' } });
      Object.assign(req, { user: { id: 'admin1', isAdmin: true }, apiKeyInfo: { scopes: ['chat'] } });

      expect(() => route.guards.forEach(guard => guard(req, res, () => {}))).toThrow(
        expect.objectContaining({ statusCode: 403 })
      );
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it('rejects a cross-site request with 403 before any write', async () => {
      const { call } = await run({ headers: { 'sec-fetch-site': 'cross-site' } });

      await expect(call).rejects.toMatchObject({ statusCode: 403 });
      expect(m.stepUp).not.toHaveBeenCalled();
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it('rejects without a recent step-up before reading, auditing or erasing anything', async () => {
      m.stepUp.mockRejectedValue(new ForbiddenError('Recent verification required', { code: STEP_UP_REQUIRED_CODE }));
      const { call } = await run();

      await expect(call).rejects.toMatchObject({ statusCode: 403, additionalInfo: { code: STEP_UP_REQUIRED_CODE } });
      expect(m.deny).not.toHaveBeenCalled();
      expect(m.requestApproval).not.toHaveBeenCalled();
      expect(m.requestErasure).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
      expect(m.sendToQueue).not.toHaveBeenCalled();
    });

    it('rejects a non-admin with 403 before any write', async () => {
      const { call } = await run({ user: { id: 'user1', isAdmin: false } });

      await expect(call).rejects.toMatchObject({ statusCode: 403 });
      expect(m.requestErasure).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
    });

    it('rejects a delegate without users:delete, naming the missing permission', async () => {
      const { call } = await run({ user: { id: 'd1', isAdmin: false, adminPermissions: ['support:read'] } });

      await expect(call).rejects.toMatchObject({ statusCode: 403, message: 'Missing permission: users:delete' });
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it('lets a delegate with users:delete delete a non-admin account', async () => {
      const { res, call } = await run({ user: { id: 'd1', isAdmin: false, adminPermissions: ['users:delete'] } });
      await call;

      expect(res._getStatusCode()).toBe(200);
      expect(m.requestErasure).toHaveBeenCalledOnce();
    });

    it('stops a delegate whose target gained admin access after the check, even with approvals off', async () => {
      m.requestErasure.mockImplementation(
        async (_r: unknown, _id: string, _n: Date, opts: { recordInTransaction: () => Promise<void> }) => {
          m.users.u1 = { id: 'u1', isAdmin: true };
          await opts.recordInTransaction();
          return { deletion: {}, subscriptions: NO_SUBS };
        }
      );
      const { call } = await run({ user: { id: 'd1', isAdmin: false, adminPermissions: ['users:delete'] } });

      await expect(call).rejects.toMatchObject({ statusCode: 409 });
      expect(m.record).not.toHaveBeenCalled();
      expect(m.sendToQueue).not.toHaveBeenCalled();
    });

    it.each([
      ['approvals off', false],
      ['approvals on', true],
    ])('refuses a delegate deleting an account with admin access (%s)', async (_label, enabled) => {
      m.policy.mockResolvedValue({ enabled, expiryHours: 24 });
      m.users.u1 = { id: 'u1', name: 'Boss', isAdmin: false, adminPermissions: ['support:read'] };
      const { call } = await run({ user: { id: 'd1', isAdmin: false, adminPermissions: ['users:delete'] } });

      await expect(call).rejects.toMatchObject({ statusCode: 403 });
      expect(m.requestApproval).not.toHaveBeenCalled();
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it('denies deleting your own account with a 403 and a user.deletion.denied entry', async () => {
      const { call } = await run({ id: 'admin1' });

      await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      expect(m.deny).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.deletion.denied', attempted: 'user.deleted' })
      );
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it('denies an impersonating admin deleting the account they impersonate from', async () => {
      const { call } = await run({ user: { id: 'B', isAdmin: true, impersonatedBy: 'A' } as never, id: 'A' });

      await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      expect(m.deny).toHaveBeenCalled();
      expect(m.requestErasure).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['too short', { reason: ' abc ' }],
      ['too long', { reason: 'x'.repeat(501) }],
    ])('answers 400 and erases nothing when the reason is %s', async (_label, body) => {
      const { call } = await run({ body });

      await expect(call).rejects.toMatchObject({ statusCode: 400 });
      expect(m.requestErasure).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
    });
  });
});

describe('deleting an admin account needs approval', () => {
  const approval = {
    id: 'appr1',
    requestedBy: { id: 'admin2', name: 'Requester', email: 'r@example.com', selfIds: ['admin2'] },
  };

  beforeEach(() => {
    m.policy.mockResolvedValue({ enabled: true, expiryHours: 24 });
    m.users.u1 = { id: 'u1', name: 'Other Admin', isAdmin: true };
  });

  it('answers 202 for an admin target and erases nothing', async () => {
    const { res, call } = await run();
    await call;

    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ approvalId: 'appr1', status: 'pending' });
    expect(m.requestApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.delete_admin',
        params: { userId: 'u1', reason: 'Confirmed duplicate account' },
        requiredPermission: 'users:delete',
        requiresFullAdmin: true,
      }),
      expect.anything()
    );
    expect(m.requestErasure).not.toHaveBeenCalled();
  });

  it('answers 409 and files no approval when the admin target already has a deletion pending', async () => {
    m.erasureState.mockResolvedValue({
      state: 'requested',
      requestedAt: '2026-01-01T00:00:00.000Z',
      requestedBy: null,
      purgeStartedAt: null,
    });
    const { call } = await run();

    await expect(call).rejects.toMatchObject({ statusCode: 409 });
    expect(m.requestApproval).not.toHaveBeenCalled();
  });

  it('answers 409 with the org-owner code and files no approval when the admin target owns organizations', async () => {
    m.erasureState.mockResolvedValue({ state: 'none', ownedOrganizations: [{ id: 'o1', name: 'Org' }] });
    const { call } = await run();

    await expect(call).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'ACCOUNT_DELETION_ORG_OWNER', organizations: [{ id: 'o1', name: 'Org' }] },
    });
    expect(m.requestApproval).not.toHaveBeenCalled();
  });

  it('gates a delegated admin target too', async () => {
    m.users.u1 = { id: 'u1', isAdmin: false, adminPermissions: ['support:read'] };
    const { res, call } = await run();
    await call;
    expect(res._getStatusCode()).toBe(202);
  });

  it('erases a non-admin target immediately', async () => {
    m.users.u1 = { id: 'u1', name: 'Target', isAdmin: false };
    const { res, call } = await run();
    await call;

    expect(res._getStatusCode()).toBe(200);
    expect(m.requestApproval).not.toHaveBeenCalled();
    expect(m.requestErasure).toHaveBeenCalledOnce();
  });

  it('runs an approved delete as the approver and points user.deleted at the approval', async () => {
    const { req } = createMocks({ method: 'POST' });
    Object.assign(req, {
      user: { id: 'admin1', isAdmin: true },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      executeApprovedAdminDelete(req as never, { userId: 'u1', reason: 'Offboarded' }, approval as never)
    ).resolves.toEqual({ deletedUserId: 'u1' });
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.deleted',
        reason: 'Offboarded',
        details: expect.objectContaining({ approval: expect.objectContaining({ id: 'appr1' }) }),
      })
    );
    expect(m.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: 'u1' });
  });

  it('links the cancellation entry to the approval and survives its audit write failing', async () => {
    m.requestErasure.mockImplementation(
      async (_r: unknown, _id: string, _n: Date, opts: { recordInTransaction: () => Promise<void> }) => {
        await opts.recordInTransaction();
        return { deletion: {}, subscriptions: { canceled: ['sub_1'], failed: [] } };
      }
    );
    const { req } = createMocks({ method: 'POST' });
    Object.assign(req, {
      user: { id: 'admin1', isAdmin: true },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const run = () =>
      executeApprovedAdminDelete(req as never, { userId: 'u1', reason: 'Offboarded' }, approval as never);

    await run();
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscriptions.canceled',
        details: expect.objectContaining({ approval: expect.objectContaining({ id: 'appr1' }) }),
      })
    );

    m.record.mockImplementation(async (_req: unknown, entry: { action: string }) => {
      if (entry.action === 'user.subscriptions.canceled') throw new Error('audit down');
      return null;
    });
    m.sendToQueue.mockClear();
    await expect(run()).resolves.toEqual({ deletedUserId: 'u1' });
    expect(m.sendToQueue).toHaveBeenCalledOnce();
  });

  it.each([
    ['an isAdmin target', { id: 'u1', isAdmin: true }],
    ['a delegated-admin target', { id: 'u1', isAdmin: false, adminPermissions: ['support:read'] }],
  ])('answers 409 and audits nothing when %s is demoted inside the stamp transaction', async (_label, target) => {
    m.users.u1 = target;
    m.requestErasure.mockImplementation(
      async (_r: unknown, _id: string, _n: Date, opts: { recordInTransaction: () => Promise<void> }) => {
        m.users.u1 = { id: 'u1', isAdmin: false, adminPermissions: [] };
        await opts.recordInTransaction();
        return { deletion: {}, subscriptions: NO_SUBS };
      }
    );
    const { req } = createMocks({ method: 'POST' });
    Object.assign(req, { user: { id: 'admin1', isAdmin: true }, logger: { info: vi.fn(), error: vi.fn() } });

    await expect(
      executeApprovedAdminDelete(req as never, { userId: 'u1', reason: 'Offboarded' }, approval as never)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses an approved delete of the approver themselves', async () => {
    const { req } = createMocks({ method: 'POST' });
    Object.assign(req, { user: { id: 'u1', isAdmin: true }, logger: { info: vi.fn() } });

    await expect(
      executeApprovedAdminDelete(req as never, { userId: 'u1', reason: 'Offboarded' }, approval as never)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(m.requestErasure).not.toHaveBeenCalled();
  });

  it('answers 409 and stamps nothing when the approved target was demoted', async () => {
    m.users.u1 = { id: 'u1', isAdmin: false, adminPermissions: [] };
    const { req } = createMocks({ method: 'POST' });
    Object.assign(req, { user: { id: 'admin1', isAdmin: true }, logger: { info: vi.fn(), error: vi.fn() } });

    await expect(
      executeApprovedAdminDelete(req as never, { userId: 'u1', reason: 'Offboarded' }, approval as never)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(m.requestErasure).not.toHaveBeenCalled();
  });
});

describe('direct deletion target role changes', () => {
  it('stops a promoted target inside the stamp transaction when approvals are on', async () => {
    m.policy.mockResolvedValue({ enabled: true, expiryHours: 24 });
    m.requestErasure.mockImplementation(
      async (_r: unknown, _id: string, _n: Date, opts: { recordInTransaction: () => Promise<void> }) => {
        m.users.u1 = { id: 'u1', isAdmin: true };
        await opts.recordInTransaction();
        return { deletion: {}, subscriptions: NO_SUBS };
      }
    );
    const { call } = await run();

    await expect(call).rejects.toMatchObject({ statusCode: 409 });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sendToQueue).not.toHaveBeenCalled();
  });
});
