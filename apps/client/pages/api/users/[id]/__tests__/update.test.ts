import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const {
  mockUserFindById,
  mockAdminUpdateUser,
  mockUpdateUser,
  mockCount,
  mockSessionEnded,
  mockRequireStepUp,
  mockRecord,
  mockDeny,
  txnState,
} = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  mockDeny: vi.fn(),
  mockUserFindById: vi.fn(),
  mockAdminUpdateUser: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockCount: vi.fn(),
  mockSessionEnded: vi.fn(),
  mockRequireStepUp: vi.fn(),
  // Records whether a findById read ran inside the change callback, so a test can pin the
  // session-end snapshot to the write's own transaction instead of a stale read before it.
  txnState: { changeRunning: false, snapshotReadInsideChange: undefined as boolean | undefined },
}));

// Runs the change and the session-end decision exactly as the real helper does (its transaction
// and revoke are covered in server/auth/endUserSessions.test.ts); a decided end is recorded.
vi.mock('@server/auth/endUserSessions', () => ({
  commitWithSessionEnd: async (
    _req: unknown,
    change: () => Promise<unknown>,
    sessionEndFor: (result: unknown) => unknown
  ) => {
    txnState.changeRunning = true;
    let result: unknown;
    try {
      result = await change();
    } finally {
      txnState.changeRunning = false;
    }
    const end = sessionEndFor(result);
    if (end) await mockSessionEnded(end);
    return result;
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PUT']?.(req, res),
      {
        use: () => chain,
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/telemetryDeletion', () => ({
  triggerTelemetryDeletion: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/ip', () => ({
  getClientIp: () => '127.0.0.1',
  truncateIp: (ip: string) => ip,
}));

vi.mock('@bike4mind/services', async orig => ({
  adminAuditService: { REDACTED_PLACEHOLDER: '[REDACTED]' },
  userService: {
    // The real block-state rules, so a snapshot missing any block field is caught.
    entersBlockedState: (await orig<typeof import('@bike4mind/services')>()).userService.entersBlockedState,
    adminUpdateUser: (...a: unknown[]) => mockAdminUpdateUser(...a),
    updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    // Both stand-ins are real allowlists (not passthrough) so the discarded-field
    // detection under test actually exercises Zod's strip-unknown-keys behavior.
    adminUpdateUserSchema: z.object({
      id: z.string(),
      name: z.string().optional(),
      email: z.string().optional(),
      password: z.string().optional(),
      isAdmin: z.boolean().optional(),
      tags: z.array(z.string()).nullable().optional(),
      currentCredits: z.number().optional(),
      creditReason: z.string().optional(),
      creditDelta: z.number().optional(),
      roleChangeReason: z.string().optional(),
      password: z.string().nullable().optional(),
      email: z.string().optional(),
      isBanned: z.boolean().optional(),
      moderationStatus: z.string().optional(),
    }),
    updateUserSchema: z.object({
      name: z.string().optional(),
      role: z.string().optional(),
      password: z.string().nullable().optional(),
    }),
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: vi.fn() },
  realtimeConnectionRepository: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
  User: {
    findById: (...a: unknown[]) => {
      const result = mockUserFindById(...a);
      // Mirrors Mongoose's Query: chainable via .select()/.lean(), but also
      // directly awaitable (the handler awaits User.findById(userId) bare in
      // its post-update refetch), so `then` needs to resolve to the same result.
      let projected = result;
      const query = {
        // Applies the projection like Mongo would, so a field dropped from a .select() is absent.
        select: (fields: string) => {
          const keep = fields.split(' ');
          // The session-end snapshot is the only read that asks for every block field; note
          // whether it happened inside the change callback (the transaction) or before it.
          if (fields === 'isAdmin email isBanned disputePending moderation') {
            txnState.snapshotReadInsideChange = txnState.changeRunning;
          }
          projected =
            result && typeof result === 'object'
              ? Object.fromEntries(Object.entries(result).filter(([key]) => keep.includes(key)))
              : result;
          return query;
        },
        lean: () => Promise.resolve(projected),
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return query;
    },
  },
  userRepository: { count: (...a: unknown[]) => mockCount(...a) },
  friendshipRepository: {},
  creditTransactionRepository: {},
  Organization: {},
  withTransaction: (fn: () => unknown) => fn(),
  TelemetryAuditLogModel: { create: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));

// parseAdminActionReason and isSameUserId stay real so the 400s are the route's own.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
  denySelfAdminAction: (...a: unknown[]) => mockDeny(...a),
}));

// The gate's own behaviour is covered in server/auth/stepUp.test.ts; here only where it applies.
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: mockRequireStepUp }));

import { adminSettingsRepository } from '@bike4mind/database';
import handler from '../update';

const run = ({
  user,
  userId = 'u1',
  body = {},
  apiKeyInfo,
}: {
  user?: unknown;
  userId?: string;
  body?: Record<string, unknown>;
  apiKeyInfo?: unknown;
} = {}) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: userId }, body });
  if (user) (req as Record<string, unknown>).user = user;
  if (apiKeyInfo) (req as Record<string, unknown>).apiKeyInfo = apiKeyInfo;
  (req as Record<string, unknown>).logger = { updateMetadata: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  // Default: a plain truthy user doc, standing in for whatever findById was called
  // for (the lockout check, the post-update refetch, or both). Individual tests
  // override this with mockReturnValue when the returned shape matters.
  mockUserFindById.mockReset().mockReturnValue({ id: 'u1', name: 'Existing Name' });
  mockAdminUpdateUser.mockReset().mockResolvedValue({ user: undefined, creditAdjustment: undefined });
  mockRecord.mockReset().mockResolvedValue(null);
  mockDeny.mockReset().mockImplementation(async () => {
    throw new ForbiddenError('Admins cannot perform this action on their own account.');
  });
  mockUpdateUser.mockReset().mockResolvedValue(undefined);
  mockCount.mockReset().mockResolvedValue(2);
  mockSessionEnded.mockReset().mockResolvedValue(undefined);
  txnState.changeRunning = false;
  txnState.snapshotReadInsideChange = undefined;
  mockRequireStepUp.mockReset().mockResolvedValue(undefined);
});

describe('PUT /api/users/:id/update - changing your own password', () => {
  const SELF = { id: 'u1', isAdmin: false };
  const stepUpRequired = Object.assign(new ForbiddenError('Recent verification required'), {
    additionalInfo: { code: 'step_up_required' },
  });

  it('requires recent verification and does not write without it', async () => {
    mockRequireStepUp.mockRejectedValue(stepUpRequired);
    const { promise } = run({ user: SELF, userId: 'u1', body: { password: 'new-password' } });
    await expect(promise).rejects.toBe(stepUpRequired);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // applyBaseUserUpdates hashes '' as a real password, so the gate must not use a truthiness check.
  it('gates an empty-string password too', async () => {
    mockRequireStepUp.mockRejectedValue(stepUpRequired);
    const { promise } = run({ user: SELF, userId: 'u1', body: { password: '' } });
    await expect(promise).rejects.toBe(stepUpRequired);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses an empty-string password from an API key outright', async () => {
    const { promise } = run({
      user: SELF,
      userId: 'u1',
      body: { password: '' },
      apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] },
    });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('writes once recently verified', async () => {
    const { res, promise } = run({ user: SELF, userId: 'u1', body: { password: 'new-password' } });
    await promise;
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('gates an admin changing their own password too', async () => {
    mockRequireStepUp.mockRejectedValue(stepUpRequired);
    const { promise } = run({ user: ADMIN, userId: ADMIN.id, body: { password: 'new-password' } });
    await expect(promise).rejects.toBe(stepUpRequired);
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('refuses a password from an API key outright', async () => {
    const { promise } = run({
      user: SELF,
      userId: 'u1',
      body: { password: 'new-password' },
      apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] },
    });
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('treats an upper-case form of your own id as yourself', async () => {
    const ownId = '65a1b2c3d4e5f6a7b8c9d0e1';
    mockRequireStepUp.mockRejectedValue(stepUpRequired);
    const { promise } = run({
      user: { ...ADMIN, id: ownId },
      userId: ownId.toUpperCase(),
      body: { password: 'new-password' },
    });
    await expect(promise).rejects.toMatchObject({ statusCode: 403, additionalInfo: { code: 'step_up_required' } });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('gates an admin changing their own email, and writes once recently verified', async () => {
    mockRequireStepUp.mockRejectedValueOnce(stepUpRequired);
    const blocked = run({ user: ADMIN, userId: ADMIN.id, body: { email: 'new@example.com' } });
    await expect(blocked.promise).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { code: 'step_up_required' },
    });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();

    const allowed = run({ user: ADMIN, userId: ADMIN.id, body: { email: 'new@example.com' } });
    await allowed.promise;
    expect(allowed.res._getStatusCode()).toBe(200);
    expect(mockRequireStepUp).toHaveBeenCalledTimes(2);
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('refuses an admin changing their own email with an API key', async () => {
    const { promise } = run({
      user: ADMIN,
      userId: ADMIN.id,
      body: { email: 'new@example.com' },
      apiKeyInfo: { scopes: [ApiKeyScope.ADMIN] },
    });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('leaves updates without a password ungated', async () => {
    await run({ user: SELF, userId: 'u1', body: { name: 'New' } }).promise;
    await run({ user: SELF, userId: 'u1', body: { password: null } }).promise;
    expect(mockRequireStepUp).not.toHaveBeenCalled();
  });
});

describe("PUT /api/users/:id/update - an admin changing another user's credentials or role", () => {
  const stepUpRequired = Object.assign(new ForbiddenError('Recent verification required'), {
    additionalInfo: { code: 'step_up_required' },
  });
  const API_KEY = { keyId: 'k1', scopes: [ApiKeyScope.ADMIN] };
  const gatedBodies: Array<[string, Record<string, unknown>]> = [
    ['password', { password: 'reset-value' }],
    ['email', { email: 'other@example.com' }],
    ['an admin-role grant', { isAdmin: true, roleChangeReason: 'Promoted to run support' }],
  ];

  it.each(gatedBodies)('requires recent verification for %s and does not write without it', async (_label, body) => {
    mockRequireStepUp.mockRejectedValue(stepUpRequired);
    const { promise } = run({ user: ADMIN, userId: 'other-user', body });
    await expect(promise).rejects.toMatchObject({ statusCode: 403, additionalInfo: { code: 'step_up_required' } });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it.each(gatedBodies)('writes %s once recently verified', async (_label, body) => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body });
    await promise;
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(1);
  });

  it.each(gatedBodies)('refuses %s from an API key before any write', async (_label, body) => {
    const { promise } = run({ user: ADMIN, userId: 'other-user', body, apiKeyInfo: API_KEY });
    await expect(promise).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/signed-in session/),
    });
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('does not gate setting isAdmin: true on a user who is already an admin', async () => {
    mockUserFindById.mockReturnValue({ id: 'other-user', isAdmin: true });
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockRequireStepUp).not.toHaveBeenCalled();
  });

  it.each([
    ['revoking the admin role', { isAdmin: false, roleChangeReason: 'Left the support team' }],
    ['a ban', { isBanned: true }],
    ['an unrelated field', { name: 'Renamed' }],
  ])('leaves %s ungated, including with an API key', async (_label, body) => {
    mockUserFindById.mockReturnValue({ id: 'other-user', isAdmin: true });
    await run({ user: ADMIN, userId: 'other-user', body }).promise;
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body, apiKeyInfo: API_KEY });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockRequireStepUp).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(2);
  });
});

describe('PUT /api/users/:id/update - lockout guard', () => {
  it('denies an admin demoting their OWN Super Admin role with a 403, even when other admins exist', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(5);
    const { promise } = run({ user: ADMIN, userId: ADMIN.id, body: { isAdmin: false } });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mockDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.role.denied', attempted: 'user.role.admin_revoked' })
    );
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects demoting the LAST remaining Super Admin (a different user)', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(1);
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-admin',
      body: { isAdmin: false, roleChangeReason: 'Left the company' },
    });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/last remaining/i);
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('allows demoting a non-last admin (a different user)', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(2);
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-admin',
      body: { isAdmin: false, roleChangeReason: 'Left the company' },
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalled();
    expect(mockAdminUpdateUser.mock.calls[0][2].db.userApiKeys).toBeDefined();
  });

  it('does not run the lockout check at all for a non-demote update (isAdmin absent from body)', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { tags: ['opti'] } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // The audit target read, the in-transaction snapshot, the post-update refetch and the
    // before/after profile-audit snapshots; the guard's isAdmin count is skipped entirely.
    expect(mockUserFindById).toHaveBeenCalledTimes(5);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('does not run the lockout check when promoting a user (isAdmin: true)', async () => {
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-user',
      body: { isAdmin: true, roleChangeReason: 'Promoted to run support' },
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Role-grant check, audit target read, in-transaction snapshot and refetch; no lockout guard read.
    expect(mockUserFindById).toHaveBeenCalledTimes(4);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('does not block demoting a target who is not currently an admin', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: false });
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { isAdmin: false } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/update - admin branch requires the admin scope', () => {
  // The route cannot declare `requiredScopes`: it is also every ordinary user's own
  // profile update. So the gate sits on the admin branch, which writes credits,
  // roles and email.
  it('403s an api-key caller without admin:* on the admin branch', async () => {
    const { promise } = run({
      user: ADMIN,
      userId: 'someone-else',
      body: { currentCredits: 999999 },
      apiKeyInfo: { keyId: 'k1', scopes: [ApiKeyScope.AI_CHAT] },
    });
    // Thrown, not written: baseApi is stubbed here, and its real errorHandler is what renders
    // the shared envelope (name, error, request_id) around this additionalInfo.
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ statusCode: 403, additionalInfo: { required_scopes: [ApiKeyScope.ADMIN] } });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('admits an api-key caller that holds admin:*', async () => {
    const { promise } = run({
      user: ADMIN,
      userId: 'someone-else',
      body: { currentCredits: 10, creditReason: 'Goodwill credit' },
      apiKeyInfo: { keyId: 'k1', scopes: [ApiKeyScope.ADMIN] },
    });
    await promise;

    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('leaves JWT admins alone - no apiKeyInfo means no scope gate', async () => {
    const { promise } = run({
      user: ADMIN,
      userId: 'someone-else',
      body: { currentCredits: 10, creditReason: 'Goodwill credit' },
    });
    await promise;

    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/update - setting a balance to zero', () => {
  it('forwards currentCredits: 0 with its reason when the target holds credits', async () => {
    mockUserFindById.mockReturnValue({ id: 'u1', currentCredits: 100 });
    const { promise } = run({
      user: ADMIN,
      userId: 'u1',
      body: { currentCredits: 0, creditReason: 'Zeroed after abuse review' },
    });
    await promise;

    expect(mockAdminUpdateUser).toHaveBeenCalledWith(
      ADMIN.id,
      expect.objectContaining({ currentCredits: 0, creditReason: 'Zeroed after abuse review' }),
      expect.anything()
    );
  });

  it('drops currentCredits: 0 when the balance is already zero, so no reason is demanded', async () => {
    mockUserFindById.mockReturnValue({ id: 'u1', currentCredits: 0 });
    const { promise } = run({ user: ADMIN, userId: 'u1', body: { currentCredits: 0 } });
    await promise;

    const params = mockAdminUpdateUser.mock.calls[0][1] as Record<string, unknown>;
    expect(params.currentCredits).toBeUndefined();
  });

  it('rejects a zero balance change without a reason', async () => {
    mockUserFindById.mockReturnValue({ id: 'u1', currentCredits: 100 });
    const { promise } = run({ user: ADMIN, userId: 'u1', body: { currentCredits: 0 } });

    await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/update - admin unknown-field discard', () => {
  it('reports unknown fields instead of silently dropping them', async () => {
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-user',
      body: { name: 'Renamed', adminNote: 'comped', nickname: 'Bob' },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toEqual(expect.arrayContaining(['adminNote', 'nickname']));
    expect(json.ignoredFields).toHaveLength(2);

    const [, calledBody] = mockAdminUpdateUser.mock.calls[0];
    expect(calledBody).toEqual({ id: 'other-user', name: 'Renamed' });
  });

  it('rejects a credit change whose reason was misnamed adminNote, instead of dropping it', async () => {
    // `adminNote` is the real misnaming that shipped once (see useUpdateUserCredits): the intended
    // field is `creditReason`. It parses away, so the reason check now turns it into a 400.
    const { promise } = run({ user: ADMIN, userId: 'other-user', body: { currentCredits: 500, adminNote: 'comped' } });

    await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('omits ignoredFields entirely when every submitted key is allowed', async () => {
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-user',
      body: { currentCredits: 500, creditReason: 'comped' },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().ignoredFields).toBeUndefined();
  });

  it('does not count the route-param id as an ignored field when the body also carries one', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { id: 'spoofed', name: 'New Name' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().ignoredFields).toBeUndefined();
    // The route param still wins over the body's id.
    const [, calledBody] = mockAdminUpdateUser.mock.calls[0];
    expect(calledBody).toEqual({ id: 'other-user', name: 'New Name' });
  });

  it('returns a null body, not a bare { ignoredFields } object, when the user row is gone by the refetch', async () => {
    mockUserFindById.mockReturnValue(null);
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { name: 'New Name', adminNote: 'x' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toBeNull();
  });
});

describe('PUT /api/users/:id/update - self-service admin-only field discard', () => {
  const SELF = { id: 'u1', isAdmin: false };

  it('reports discarded admin-only fields instead of silently dropping them', async () => {
    const { res, promise } = run({
      user: SELF,
      userId: SELF.id,
      body: { name: 'New Name', creditDelta: 500, tags: ['vip'], isAdmin: true },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toEqual(expect.arrayContaining(['creditDelta', 'tags', 'isAdmin']));
    expect(json.ignoredFields).toHaveLength(3);

    // The privileged fields never reach the service layer.
    expect(mockUpdateUser).toHaveBeenCalledWith(
      SELF.id,
      expect.not.objectContaining({ creditDelta: 500, tags: ['vip'], isAdmin: true }),
      expect.anything()
    );
    const [, calledBody] = mockUpdateUser.mock.calls[0];
    expect(calledBody).toEqual({ name: 'New Name' });
  });

  it('omits ignoredFields entirely when every submitted key is allowed', async () => {
    const { res, promise } = run({ user: SELF, userId: SELF.id, body: { name: 'New Name' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toBeUndefined();
    expect(mockUpdateUser).toHaveBeenCalledWith(SELF.id, { name: 'New Name' }, expect.anything());
  });

  it('hands the self-service update the admin settings that decide a reserved username', async () => {
    const { promise } = run({ user: SELF, userId: SELF.id, body: { name: 'New Name' } });
    await promise;

    expect(mockUpdateUser).toHaveBeenCalledWith(
      SELF.id,
      { name: 'New Name' },
      { db: expect.objectContaining({ adminSettings: adminSettingsRepository }) }
    );
  });

  it('reports an empty-body update with no admin-only fields sent as having none ignored', async () => {
    const { res, promise } = run({ user: SELF, userId: SELF.id, body: {} });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().ignoredFields).toBeUndefined();
  });

  it('returns a null body, not a bare { ignoredFields } object, when the user row is gone by the refetch', async () => {
    mockUserFindById.mockReturnValue(null);
    const { res, promise } = run({
      user: SELF,
      userId: SELF.id,
      body: { name: 'New Name', isAdmin: true },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toBeNull();
  });
});

describe('PUT /api/users/:id/update - real allowlist binds the ignoredFields guarantee', () => {
  it('does not list creditDelta, tags, or isAdmin in the real self-service allowlist', async () => {
    // Bypasses the module-level @bike4mind/services mock (which stands in a
    // two-key schema for the handler tests above) to load the actual schema
    // that ships in production. If any of these three fields were ever added
    // to it, this assertion would fail before the protection in issue #2838
    // silently disappeared.
    const { userService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    const allowedKeys = new Set(Object.keys(userService.updateUserSchema.shape));

    expect(allowedKeys.has('creditDelta')).toBe(false);
    expect(allowedKeys.has('tags')).toBe(false);
    expect(allowedKeys.has('isAdmin')).toBe(false);

    // Reproduces update.ts's own ignoredFields computation against the real
    // allowlist, so this test breaks the same way the handler would if one of
    // these fields were ever added to updateUserSchema.
    const submitted = { name: 'New Name', creditDelta: 500, tags: ['vip'], isAdmin: true };
    const ignoredFields = Object.keys(submitted).filter(key => !allowedKeys.has(key));
    expect(ignoredFields).toEqual(expect.arrayContaining(['creditDelta', 'tags', 'isAdmin']));
    expect(ignoredFields).toHaveLength(3);
  });

  it('strips unknown keys from the real admin allowlist, so the handler has something to report', async () => {
    const { userService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    const allowedKeys = new Set(Object.keys(userService.adminUpdateUserSchema.shape));

    // The credit-adjustment reason is `creditReason`; `adminNote` is the name that
    // was mistakenly sent once and dropped. If the schema ever gained a passthrough
    // or a catch-all, this would stop holding and the handler would report nothing.
    expect(allowedKeys.has('creditReason')).toBe(true);
    expect(allowedKeys.has('adminNote')).toBe(false);

    const parsed = userService.adminUpdateUserSchema.parse({ id: 'u1', currentCredits: 500, adminNote: 'comped' });
    expect(parsed).not.toHaveProperty('adminNote');
  });
});

describe('PUT /api/users/:id/update - ends sessions on credential and account-state changes', () => {
  const SELF = { id: 'u1', isAdmin: false };
  const BEFORE = { id: 'target', email: 'old@example.com', isBanned: false, disputePending: false };

  /** The pre-update snapshot (findById) and the user as adminUpdateUser wrote it. */
  function adminEdit(before: object, written: object) {
    mockUserFindById.mockReturnValue(before);
    mockAdminUpdateUser.mockResolvedValue({ user: written, creditAdjustment: undefined });
  }

  it('signs the user out everywhere after a self-service password change', async () => {
    const { promise } = run({ user: SELF, userId: 'u1', body: { password: 'n3w-Passw0rd!' } });
    await promise;

    expect(mockSessionEnded).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded).toHaveBeenCalledWith({ userId: 'u1', reason: 'password_changed' });
  });

  it('signs the user out everywhere when the self-service password is an empty string', async () => {
    // The service writes `""` like any other password (it only skips undefined/null), so the
    // session-end gate must match that rule rather than the string's truthiness.
    const { promise } = run({ user: SELF, userId: 'u1', body: { password: '' } });
    await promise;

    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded).toHaveBeenCalledWith({ userId: 'u1', reason: 'password_changed' });
  });

  it('leaves sessions alone for a self-service update that sets no password', async () => {
    const { promise } = run({ user: SELF, userId: 'u1', body: { name: 'New Name', password: null } });
    await promise;

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded).not.toHaveBeenCalled();
  });

  it.each([
    ['sets their password', { password: 'n3w-Passw0rd!' }, BEFORE, 'password_changed'],
    ['sets an empty-string password', { password: '' }, BEFORE, 'password_changed'],
    ['changes their email', { email: 'new@example.com' }, { ...BEFORE, email: 'new@example.com' }, 'email_changed'],
    ['bans them', { isBanned: true }, { ...BEFORE, isBanned: true }, 'account_blocked'],
    [
      'suspends them',
      { moderationStatus: 'suspended' },
      { ...BEFORE, moderation: { status: 'suspended' } },
      'account_blocked',
    ],
  ])('signs the target out everywhere when an admin %s', async (_label, body, written, reason) => {
    adminEdit(BEFORE, written);
    const { promise } = run({ user: ADMIN, userId: 'target', body });
    await promise;

    expect(mockSessionEnded).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded).toHaveBeenCalledWith({ userId: 'target', reason, actorUserId: ADMIN.id });
  });

  it('reads the session-end snapshot inside the write, not before it', async () => {
    // The reason has to see the state the write saw; a read before the write can be stale by the
    // time it commits (and stays stale across a transaction retry).
    adminEdit(BEFORE, { ...BEFORE, isBanned: true });
    const { promise } = run({ user: ADMIN, userId: 'target', body: { isBanned: true } });
    await promise;

    expect(txnState.snapshotReadInsideChange).toBe(true);
  });

  it('ends sessions once, under the account-block reason, when one admin edit does several', async () => {
    adminEdit(BEFORE, { ...BEFORE, email: 'new@example.com', isBanned: true });
    const { promise } = run({
      user: ADMIN,
      userId: 'target',
      body: { password: 'n3w-Passw0rd!', email: 'new@example.com', isBanned: true },
    });
    await promise;

    expect(mockSessionEnded).toHaveBeenCalledTimes(1);
    expect(mockSessionEnded.mock.calls[0][0].reason).toBe('account_blocked');
  });

  it('records no separate actor when an admin changes their own password', async () => {
    adminEdit({ ...BEFORE, id: ADMIN.id }, { ...BEFORE, id: ADMIN.id });
    const { promise } = run({ user: ADMIN, userId: ADMIN.id, body: { password: 'n3w-Passw0rd!' } });
    await promise;

    expect(mockSessionEnded).toHaveBeenCalledWith({ userId: ADMIN.id, reason: 'password_changed' });
  });

  it.each([
    ['a name-only edit', BEFORE, BEFORE],
    ['re-saving the same email', BEFORE, BEFORE],
    ['saving a banned user', { ...BEFORE, isBanned: true }, { ...BEFORE, isBanned: true }],
    [
      'saving a user already under a dispute hold',
      { ...BEFORE, disputePending: true },
      { ...BEFORE, disputePending: true },
    ],
    [
      'saving an already suspended user',
      { ...BEFORE, moderation: { status: 'suspended' } },
      { ...BEFORE, moderation: { status: 'suspended' } },
    ],
  ])('leaves sessions alone for %s', async (_label, before, written) => {
    adminEdit(before, written);
    const { promise } = run({ user: ADMIN, userId: 'target', body: { name: 'x', email: 'old@example.com' } });
    await promise;

    expect(mockSessionEnded).not.toHaveBeenCalled();
  });

  it.each([
    ['self-service', SELF, 'u1'],
    ['admin', ADMIN, 'target'],
  ])('fails the %s request when the session end fails', async (_label, user, userId) => {
    adminEdit(BEFORE, BEFORE);
    mockSessionEnded.mockRejectedValue(new Error('db down'));
    const { promise } = run({ user, userId, body: { password: 'n3w-Passw0rd!' } });

    await expect(promise).rejects.toThrow('db down');
  });
});

describe('PUT /api/users/:id/update - respond() boundary', () => {
  const profile = {
    id: 'u1',
    name: 'Existing Name',
    securityQuestions: [{ question: 'Pet name?', answer: 'Fluffy' }],
    userNotes: [{ note: 'admin note', timestamp: '2026-01-01', userName: 'admin' }],
    signupMeta: { ip: '203.0.113.7', asn: 16509, isDatacenter: true },
    signupGrantAssessment: {
      band: 'review',
      credits: 0,
      score: 3,
      reasons: ['datacenter'],
      missing: [],
      policyVersion: 'test',
      status: 'evaluated',
    },
    notInSchema: 'x',
  };

  it('admin branch keeps ignoredFields, securityQuestions, userNotes and signupMeta and strips an undeclared key', async () => {
    mockUserFindById.mockReturnValue(profile);
    const { res, promise } = run({ user: ADMIN, userId: 'u1', body: { name: 'New Name', adminNote: 'x' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toEqual(['adminNote']);
    expect(json.securityQuestions).toEqual([{ question: 'Pet name?', answer: '' }]);
    expect(json.userNotes).toEqual(profile.userNotes);
    expect(json.signupMeta).toEqual(profile.signupMeta);
    expect(json.signupGrantAssessment).toEqual(profile.signupGrantAssessment);
    expect(json).not.toHaveProperty('notInSchema');
  });

  it('self branch keeps ignoredFields and securityQuestions, drops userNotes, and strips an undeclared key', async () => {
    mockUserFindById.mockReturnValue(profile);
    const { res, promise } = run({
      user: { id: 'u1', isAdmin: false },
      userId: 'u1',
      body: { name: 'N', tags: ['x'] },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toEqual(['tags']);
    expect(json.securityQuestions).toEqual([{ question: 'Pet name?', answer: '' }]);
    expect(json).not.toHaveProperty('userNotes');
    expect(json).not.toHaveProperty('signupMeta');
    expect(json).not.toHaveProperty('signupGrantAssessment');
    expect(json).not.toHaveProperty('notInSchema');
  });
});

describe('PUT /api/users/:id/update - admin audit trail', () => {
  const ROLE_REASON = 'Promoted to run support';
  const CREDIT_REASON = 'Goodwill after the outage';
  const target = (overrides: Record<string, unknown> = {}) => ({
    id: 'other-user',
    name: 'Other',
    isAdmin: false,
    currentCredits: 100,
    ...overrides,
  });

  describe('role changes', () => {
    it.each([
      ['grants', true, false, 'user.role.admin_granted'],
      ['revokes', false, true, 'user.role.admin_revoked'],
    ])('records %s with the reason and an isAdmin change row', async (_label, after, before, action) => {
      mockUserFindById.mockReturnValue(target({ isAdmin: before }));
      mockAdminUpdateUser.mockResolvedValue({ user: target({ isAdmin: after }), creditAdjustment: undefined });
      const { res, promise } = run({
        user: ADMIN,
        userId: 'other-user',
        body: { isAdmin: after, roleChangeReason: `  ${ROLE_REASON}  ` },
      });
      await promise;

      expect(res._getStatusCode()).toBe(200);
      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action,
          target: expect.objectContaining({ kind: 'user', id: 'other-user' }),
          reason: ROLE_REASON,
          changes: [{ field: 'isAdmin', before, after }],
        })
      );
    });

    it('records inside the commitWithSessionEnd transaction', async () => {
      mockUserFindById.mockReturnValue(target({ isAdmin: true }));
      mockAdminUpdateUser.mockResolvedValue({ user: target({ isAdmin: false }), creditAdjustment: undefined });
      let changeRunningAtRecord: boolean | undefined;
      mockRecord.mockImplementation(async () => {
        changeRunningAtRecord = txnState.changeRunning;
        return null;
      });
      await run({
        user: ADMIN,
        userId: 'other-user',
        body: { isAdmin: false, roleChangeReason: ROLE_REASON },
      }).promise;

      expect(changeRunningAtRecord).toBe(true);
    });

    it.each([
      ['missing', undefined],
      ['too short', ' abc '],
    ])('answers 400 and writes nothing when the role change reason is %s', async (_label, roleChangeReason) => {
      mockUserFindById.mockReturnValue(target({ isAdmin: true }));
      const { promise } = run({ user: ADMIN, userId: 'other-user', body: { isAdmin: false, roleChangeReason } });

      await expect(promise).rejects.toMatchObject({ statusCode: 400 });
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('does not record when the isAdmin flag is unchanged', async () => {
      mockUserFindById.mockReturnValue(target({ isAdmin: true }));
      await run({ user: ADMIN, userId: 'other-user', body: { isAdmin: true } }).promise;

      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('fails the request when the audit write fails, so the transaction aborts', async () => {
      mockUserFindById.mockReturnValue(target({ isAdmin: true }));
      mockAdminUpdateUser.mockResolvedValue({ user: target({ isAdmin: false }), creditAdjustment: undefined });
      mockRecord.mockRejectedValue(new Error('audit down'));
      const { promise } = run({
        user: ADMIN,
        userId: 'other-user',
        body: { isAdmin: false, roleChangeReason: ROLE_REASON },
      });

      await expect(promise).rejects.toThrow('audit down');
    });

    it('denies a self role change before the reason is even checked', async () => {
      mockUserFindById.mockReturnValue(target({ id: ADMIN.id, isAdmin: true }));
      const { promise } = run({ user: ADMIN, userId: ADMIN.id, body: { isAdmin: false } });

      await expect(promise).rejects.toMatchObject({ statusCode: 403 });
      expect(mockDeny).toHaveBeenCalledTimes(1);
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('credit changes', () => {
    const adjustment = (credits: number, previousBalance = 100) => ({
      credits,
      previousBalance,
      resultingBalance: previousBalance + credits,
      note: CREDIT_REASON,
      creditTransactionId: 'ctx-1',
    });

    it.each([
      ['creditDelta', { creditDelta: 50 }, 50],
      ['an absolute currentCredits', { currentCredits: 150 }, 50],
      ['a negative creditDelta', { creditDelta: -30 }, -30],
    ])('records user.credits.adjusted for %s with the signed applied delta', async (_label, change, credits) => {
      mockUserFindById.mockReturnValue(target());
      mockAdminUpdateUser.mockResolvedValue({ user: target(), creditAdjustment: adjustment(credits) });
      const { res, promise } = run({
        user: ADMIN,
        userId: 'other-user',
        body: { ...change, creditReason: CREDIT_REASON },
      });
      await promise;

      expect(res._getStatusCode()).toBe(200);
      expect(mockAdminUpdateUser.mock.calls[0][1]).toMatchObject({ creditReason: CREDIT_REASON });
      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.credits.adjusted',
          target: expect.objectContaining({ kind: 'user', id: 'other-user' }),
          reason: CREDIT_REASON,
          details: { credits },
          changes: [{ field: 'currentCredits', before: 100, after: 100 + credits }],
          related: { creditTransactionId: 'ctx-1' },
        })
      );
    });

    it('omits related when the adjustment carries no ledger transaction id', async () => {
      mockUserFindById.mockReturnValue(target());
      mockAdminUpdateUser.mockResolvedValue({
        user: target(),
        creditAdjustment: { ...adjustment(50), creditTransactionId: undefined },
      });
      await run({
        user: ADMIN,
        userId: 'other-user',
        body: { creditDelta: 50, creditReason: CREDIT_REASON },
      }).promise;

      expect(mockRecord.mock.calls[0][1].related).toBeUndefined();
    });

    it('records nothing when the service applied no adjustment', async () => {
      mockUserFindById.mockReturnValue(target());
      await run({
        user: ADMIN,
        userId: 'other-user',
        body: { creditDelta: 10, creditReason: CREDIT_REASON },
      }).promise;

      expect(mockRecord).not.toHaveBeenCalled();
    });

    it.each([
      ['creditDelta', { creditDelta: 50 }],
      ['currentCredits', { currentCredits: 150 }],
    ])('answers 400 and writes nothing when %s has no creditReason', async (_label, change) => {
      mockUserFindById.mockReturnValue(target());
      const { promise } = run({ user: ADMIN, userId: 'other-user', body: change });

      await expect(promise).rejects.toMatchObject({ statusCode: 400 });
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
    });

    it('answers 400 for a creditReason under five characters', async () => {
      mockUserFindById.mockReturnValue(target());
      const { promise } = run({
        user: ADMIN,
        userId: 'other-user',
        body: { creditDelta: 50, creditReason: 'abc' },
      });

      await expect(promise).rejects.toMatchObject({ statusCode: 400 });
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
    });

    it('needs no reason when currentCredits equals the current balance or creditDelta is 0', async () => {
      mockUserFindById.mockReturnValue(target({ currentCredits: 100 }));
      const same = run({ user: ADMIN, userId: 'other-user', body: { currentCredits: 100 } });
      await same.promise;
      const zero = run({ user: ADMIN, userId: 'other-user', body: { creditDelta: 0 } });
      await zero.promise;

      expect(same.res._getStatusCode()).toBe(200);
      expect(zero.res._getStatusCode()).toBe(200);
      expect(mockAdminUpdateUser).toHaveBeenCalledTimes(2);
      expect(mockAdminUpdateUser.mock.calls[0][1].currentCredits).toBeUndefined();
      expect(mockAdminUpdateUser.mock.calls[1][1].currentCredits).toBeUndefined();
    });

    it('denies a self credit change with a 403 and user.credits.denied', async () => {
      mockUserFindById.mockReturnValue(target({ id: ADMIN.id }));
      const { promise } = run({
        user: ADMIN,
        userId: ADMIN.id,
        body: { creditDelta: 50, creditReason: CREDIT_REASON },
      });

      await expect(promise).rejects.toMatchObject({ statusCode: 403 });
      expect(mockDeny).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.credits.denied', attempted: 'user.credits.adjusted' })
      );
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
    });

    it('denies an impersonating admin changing the credits of the account they impersonate from', async () => {
      mockUserFindById.mockReturnValue(target({ id: 'A' }));
      const { promise } = run({
        user: { id: 'B', isAdmin: true, impersonatedBy: 'A' },
        userId: 'A',
        body: { creditDelta: 50, creditReason: CREDIT_REASON },
      });

      await expect(promise).rejects.toMatchObject({ statusCode: 403 });
      expect(mockDeny).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.credits.denied', attempted: 'user.credits.adjusted' })
      );
      expect(mockAdminUpdateUser).not.toHaveBeenCalled();
    });

    it('still lets an admin edit their own profile without a credit change', async () => {
      mockUserFindById.mockReturnValue(target({ id: ADMIN.id }));
      const { res, promise } = run({ user: ADMIN, userId: ADMIN.id, body: { name: 'Renamed' } });
      await promise;

      expect(res._getStatusCode()).toBe(200);
      expect(mockDeny).not.toHaveBeenCalled();
    });
  });

  it('needs no reason and writes no audit entry for a plain profile edit', async () => {
    mockUserFindById.mockReturnValue(target());
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { tags: ['opti'] } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDeny).not.toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/update - user.profile.updated audit', () => {
  // The stored doc the mocked reads see; the mocked writers mutate it like a real commit would.
  const stored: Record<string, unknown> = {};
  const profileCalls = () => mockRecord.mock.calls.filter(([, entry]) => entry.action === 'user.profile.updated');

  beforeEach(() => {
    Object.assign(stored, { id: 'other-user', name: 'Old Name', tags: ['a'], isAdmin: false });
    mockUserFindById.mockImplementation(() => ({ ...stored }));
    mockAdminUpdateUser.mockImplementation(async (_actor: unknown, body: Record<string, unknown>) => {
      Object.assign(stored, body);
      return { user: { ...stored }, creditAdjustment: undefined };
    });
    mockUpdateUser.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
      Object.assign(stored, body);
    });
  });

  it("records the before and after of an admin editing another user's name", async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { name: 'New Name' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(profileCalls()).toHaveLength(1);
    expect(profileCalls()[0][1]).toMatchObject({
      action: 'user.profile.updated',
      target: { kind: 'user', id: 'other-user' },
      changes: [{ field: 'name', before: 'Old Name', after: 'New Name' }],
    });
  });

  it('records nothing when the sent values equal the stored ones', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { name: 'Old Name' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(profileCalls()).toHaveLength(0);
  });

  it('records nothing for an admin editing their own profile', async () => {
    Object.assign(stored, { id: ADMIN.id, name: 'Admin Old' });
    const { res, promise } = run({ user: ADMIN, userId: ADMIN.id, body: { name: 'Admin New' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(1);
    expect(profileCalls()).toHaveLength(0);
  });

  it('records an impersonated self-service edit', async () => {
    Object.assign(stored, { id: 'u1' });
    const { res, promise } = run({
      user: { id: 'u1', isAdmin: false, impersonatedBy: 'admin9' },
      userId: 'u1',
      body: { name: 'Impersonated Edit' },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(profileCalls()).toHaveLength(1);
    expect(profileCalls()[0][1]).toMatchObject({
      action: 'user.profile.updated',
      target: { kind: 'user', id: 'u1' },
      changes: [{ field: 'name', before: 'Old Name', after: 'Impersonated Edit' }],
    });
  });

  it('records nothing for a plain self-service edit with no impersonation', async () => {
    Object.assign(stored, { id: 'u1' });
    const { res, promise } = run({ user: { id: 'u1', isAdmin: false }, userId: 'u1', body: { name: 'Mine' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(profileCalls()).toHaveLength(0);
  });

  it('redacts a changed password and never reads it', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { password: 'new-secret-pw' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(profileCalls()[0][1].changes).toEqual([{ field: 'password', before: '[REDACTED]', after: '[REDACTED]' }]);
    expect(JSON.stringify(mockRecord.mock.calls.map(([, entry]) => entry))).not.toContain('new-secret-pw');
  });

  it('still responds 200 when the best-effort audit write resolves null', async () => {
    mockRecord.mockResolvedValue(null);
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { name: 'New Name' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(profileCalls()).toHaveLength(1);
  });
});
