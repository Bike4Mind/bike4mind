import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const {
  mockAdminDeleteUser,
  mockRepoDelete,
  mockFindById,
  mockPurge,
  mockReadGrants,
  mockRecord,
  mockDeny,
  mockWithTransaction,
  mockCancelSubscriptions,
} = vi.hoisted(() => ({
  mockCancelSubscriptions: vi.fn(),
  mockRecord: vi.fn(),
  mockDeny: vi.fn(),
  mockWithTransaction: vi.fn(),
  mockAdminDeleteUser: vi.fn(),
  mockRepoDelete: vi.fn(),
  mockFindById: vi.fn(),
  mockPurge: vi.fn(),
  mockReadGrants: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    delete: (fn: (req: unknown, res: unknown) => unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@bike4mind/services', () => ({
  userService: { adminDeleteUser: (...a: unknown[]) => mockAdminDeleteUser(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  realtimeConnectionRepository: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
  userRepository: {
    delete: (...a: unknown[]) => mockRepoDelete(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
  },
  adminSettingsRepository: {},
  withTransaction: (fn: () => unknown) => mockWithTransaction(fn),
}));
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
    denySelfAdminAction: (...a: unknown[]) => mockDeny(...a),
  };
});
const { mockEmitBillingEvent } = vi.hoisted(() => ({ mockEmitBillingEvent: vi.fn() }));
vi.mock('@server/analytics/signupEvents', () => ({ emitBillingEvent: mockEmitBillingEvent }));
vi.mock('@server/services/purgeDeletedUserData', () => ({
  purgeDeletedUserData: (...a: unknown[]) => mockPurge(...a),
  readUserIntegrationGrants: (...a: unknown[]) => mockReadGrants(...a),
}));

vi.mock('@server/billing/cancelAccountSubscriptions', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/billing/cancelAccountSubscriptions')>()),
  cancelAccountSubscriptions: (...a: unknown[]) => mockCancelSubscriptions(...a),
}));

import { USER_SECRET_FIELDS, ForbiddenError } from '@bike4mind/common';
import handler from '../delete';

type DeleteAdapters = { db: { users: { delete: (id: string) => Promise<unknown> } } };

async function run(options: { user?: { id: string; isAdmin: boolean }; body?: unknown; id?: string } = {}) {
  const { req, res } = createMocks({
    method: 'DELETE',
    query: { id: options.id ?? 'u1' },
    body: 'body' in options ? options.body : { reason: 'Confirmed duplicate account' },
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(req, { user: options.user ?? { id: 'admin1', isAdmin: true }, logger });
  const call = (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return { res, call };
}

beforeEach(() => {
  mockAdminDeleteUser.mockReset();
  mockRepoDelete.mockReset().mockResolvedValue({ deletedCount: 1 });
  mockFindById.mockReset().mockResolvedValue({ id: 'u1', name: 'Target' });
  mockPurge.mockReset().mockResolvedValue(undefined);
  mockReadGrants.mockReset().mockResolvedValue(null);
  mockRecord.mockReset().mockResolvedValue(null);
  mockEmitBillingEvent.mockReset().mockResolvedValue([]);
  mockWithTransaction.mockReset().mockImplementation((fn: () => unknown) => fn());
  mockCancelSubscriptions.mockReset().mockResolvedValue({ canceled: [], failed: [] });
  mockDeny.mockReset().mockImplementation(async () => {
    throw new ForbiddenError('Admins cannot perform this action on their own account.');
  });
});

describe('DELETE /api/users/[id]/delete', () => {
  it('purges the user data after the delete commits', async () => {
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { res, call } = await run();
    await call;

    expect(mockRepoDelete).toHaveBeenCalledWith('u1');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ deletedBy: 'admin1' }));
    expect(res._getJSONData()).toMatchObject({ id: 'u1' });
  });

  it('reports the deletion to Overwatch, as no action of the user, keyed on a pseudonym', async () => {
    // The account as read just before the delete, with the touches its credit follows.
    const deleted = {
      id: 'u1',
      level: 'PaidUser',
      subscribedUntil: '2099-01-01T00:00:00.000Z',
      createdAt: new Date(Date.now() - 10.5 * 24 * 60 * 60 * 1000),
      acquisition: { firstTouch: { source: 'widgets' } },
    };
    mockFindById.mockResolvedValue(deleted);
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { call } = await run();
    await call;

    expect(mockEmitBillingEvent).toHaveBeenCalledTimes(1);
    const [sent] = mockEmitBillingEvent.mock.calls[0];
    expect(sent).toMatchObject({
      user: deleted,
      event: 'account_deleted',
      metadata: { wasSubscriber: true, daysSinceSignup: 10 },
    });
    // The eventId is sent verbatim beside a hash of this, so it is never the raw user id.
    expect(sent.occurrence).not.toBe('u1');
    expect(sent.occurrence).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports nothing when the delete never ran', async () => {
    mockAdminDeleteUser.mockRejectedValue(new Error('not found'));
    const { call } = await run();
    await expect(call).rejects.toThrow('not found');
    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('escapes names and email in the admin notification body', async () => {
    mockAdminDeleteUser.mockImplementation(
      async (
        _admin: string,
        _p: unknown,
        { mailer }: { mailer: { sendDeleteUserEmail: (to: string[], u: unknown, a: unknown) => Promise<void> } }
      ) => {
        await mailer.sendDeleteUserEmail(
          ['ops@example.com'],
          { name: '<b>U</b>', email: 'u&x@example.com' },
          { name: '<i>A</i>' }
        );
        return { id: 'u1' };
      }
    );

    const { call } = await run();
    await call;

    const body: string = mockPublish.mock.calls[0][0].body;
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('<i>');
    expect(body).toContain('&lt;b&gt;U&lt;/b&gt;');
    expect(body).toContain('u&amp;x@example.com');
    expect(body).toContain('&lt;i&gt;A&lt;/i&gt;');
  });

  it('still purges, and still reports the deletion, when a notification throws after the delete committed', async () => {
    const order: string[] = [];
    mockPurge.mockImplementation(async () => void order.push('purge'));
    mockEmitBillingEvent.mockImplementation(async () => {
      order.push('report');
      return [];
    });
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      throw new Error('mailer down');
    });

    const { call } = await run();

    await expect(call).rejects.toThrow('mailer down');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ deletedBy: 'admin1' }));
    // A retry would 404, so this is the only chance to send it.
    expect(mockEmitBillingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }), event: 'account_deleted' })
    );
    expect(order).toEqual(['purge', 'report']);
  });

  it('does not purge when the delete never ran (unauthorized or not found)', async () => {
    mockAdminDeleteUser.mockRejectedValue(new Error('You are not authorized to delete users'));

    const { call } = await run();

    await expect(call).rejects.toThrow('not authorized');
    expect(mockRepoDelete).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('reads the integration grants before the delete and hands them to the purge', async () => {
    const grants = { googleDrive: { refreshToken: 'enc-refresh' }, atlassianConnect: { accessToken: 'enc-access' } };
    mockReadGrants.mockImplementation(async () => {
      expect(mockRepoDelete).not.toHaveBeenCalled();
      return grants;
    });
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { call } = await run();
    await call;

    expect(mockReadGrants).toHaveBeenCalledWith('u1');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ integrationGrants: grants }));
  });

  it('does not delete when the grants cannot be read, so the revoke is never lost', async () => {
    mockReadGrants.mockRejectedValue(new Error('mongo down'));
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { call } = await run();

    await expect(call).rejects.toThrow('mongo down');
    expect(mockRepoDelete).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('returns the serialized user shape with none of the USER_SECRET_FIELDS', async () => {
    const secrets = Object.fromEntries(USER_SECRET_FIELDS.map(f => [f, 'x']));
    mockAdminDeleteUser.mockResolvedValue({ id: 'u1', name: 'N', email: 'n@example.com', ...secrets });

    const { res, call } = await run();
    await call;

    const body = res._getJSONData();
    expect(body).toMatchObject({ id: 'u1', name: 'N' });
    expect(body).not.toHaveProperty('email');
    for (const f of USER_SECRET_FIELDS) expect(body).not.toHaveProperty(f);
  });

  describe('audit trail', () => {
    it('rejects a non-admin with 401 before any write', async () => {
      const { call } = await run({ user: { id: 'user1', isAdmin: false } });

      await expect(call).rejects.toThrow('not authorized');
      expect(mockAdminDeleteUser).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('denies deleting your own account with a 403 and a user.deletion.denied entry', async () => {
      const { call } = await run({ id: 'admin1' });

      await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockDeny).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.deletion.denied', attempted: 'user.deleted' })
      );
      expect(mockAdminDeleteUser).not.toHaveBeenCalled();
    });

    it('denies an impersonating admin deleting the account they impersonate from', async () => {
      const { call } = await run({ user: { id: 'B', isAdmin: true, impersonatedBy: 'A' } as never, id: 'A' });

      await expect(call).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockDeny).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.deletion.denied', attempted: 'user.deleted' })
      );
      expect(mockAdminDeleteUser).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['too short', { reason: ' abc ' }],
      ['too long', { reason: 'x'.repeat(501) }],
    ])('answers 400 and deletes nothing when the reason is %s', async (_label, body) => {
      const { call } = await run({ body });

      await expect(call).rejects.toMatchObject({ statusCode: 400 });
      expect(mockAdminDeleteUser).not.toHaveBeenCalled();
      expect(mockRepoDelete).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('runs the delete inside withTransaction and records user.deleted with the reason', async () => {
      const order: string[] = [];
      mockWithTransaction.mockImplementation(async (fn: () => unknown) => {
        order.push('tx:start');
        const result = await fn();
        order.push('tx:end');
        return result;
      });
      mockRepoDelete.mockImplementation(async () => {
        order.push('delete');
        return { deletedCount: 1 };
      });
      mockRecord.mockImplementation(async () => {
        order.push('record');
        return null;
      });
      mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
        await db.users.delete('u1');
        return { id: 'u1' };
      });

      const { call } = await run({ body: { reason: '  Confirmed duplicate account  ' } });
      await call;

      expect(order).toEqual(['tx:start', 'delete', 'record', 'tx:end']);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.deleted',
          target: expect.objectContaining({ kind: 'user', id: 'u1' }),
          reason: 'Confirmed duplicate account',
        })
      );
    });

    it('cancels the Stripe subscriptions before the row goes, and records them on user.deleted', async () => {
      const order: string[] = [];
      mockCancelSubscriptions.mockImplementation(async () => {
        order.push('cancel');
        return {
          canceled: ['sub_a'],
          failed: [{ customerId: 'cus_org', subscriptionId: null, reason: 'stripe down' }],
        };
      });
      mockRepoDelete.mockImplementation(async () => {
        order.push('delete');
        return { deletedCount: 1 };
      });
      mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
        await db.users.delete('u1');
        return { id: 'u1' };
      });

      const { call } = await run();
      await call;

      expect(order).toEqual(['cancel', 'delete']);
      expect(mockCancelSubscriptions).toHaveBeenCalledWith(
        { userId: 'u1', reason: 'account_deleted' },
        expect.anything()
      );
      expect(mockRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.deleted',
          summary: expect.stringContaining('canceled 1 Stripe subscription(s)'),
          details: {
            canceledSubscriptions: ['sub_a'],
            failedSubscriptions: [{ customerId: 'cus_org', subscriptionId: null, reason: 'stripe down' }],
          },
        })
      );
      // A Stripe failure never blocks the delete.
      expect(mockPurge).toHaveBeenCalled();
    });

    it('cancels nothing when the delete is refused', async () => {
      const { call } = await run({ user: { id: 'u1', isAdmin: true }, id: 'u1' });
      await expect(call).rejects.toThrow(ForbiddenError);
      expect(mockCancelSubscriptions).not.toHaveBeenCalled();
    });

    it('does not purge when the audit write aborts the delete transaction', async () => {
      mockRecord.mockRejectedValue(new Error('audit down'));
      mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
        await db.users.delete('u1');
        return { id: 'u1' };
      });

      const { call } = await run();

      await expect(call).rejects.toThrow('audit down');
      expect(mockPurge).not.toHaveBeenCalled();
      expect(mockEmitBillingEvent).not.toHaveBeenCalled();
    });
  });
});
