import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const { mockUserFindById, mockAdminUpdateUser, mockUpdateUser, mockCount, mockSessionEnded, txnState } = vi.hoisted(
  () => ({
    mockUserFindById: vi.fn(),
    mockAdminUpdateUser: vi.fn(),
    mockUpdateUser: vi.fn(),
    mockCount: vi.fn(),
    mockSessionEnded: vi.fn(),
    // Records whether a findById read ran inside the change callback, so a test can pin the
    // session-end snapshot to the write's own transaction instead of a stale read before it.
    txnState: { changeRunning: false, snapshotReadInsideChange: undefined as boolean | undefined },
  })
);

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

vi.mock('@server/utils/ip', () => ({
  getClientIp: () => '127.0.0.1',
  truncateIp: (ip: string) => ip,
}));

vi.mock('@bike4mind/services', async orig => ({
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
      isAdmin: z.boolean().optional(),
      tags: z.array(z.string()).nullable().optional(),
      currentCredits: z.number().optional(),
      creditReason: z.string().optional(),
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
  mockAdminUpdateUser.mockReset().mockResolvedValue(undefined);
  mockUpdateUser.mockReset().mockResolvedValue(undefined);
  mockCount.mockReset().mockResolvedValue(2);
  mockSessionEnded.mockReset().mockResolvedValue(undefined);
  txnState.changeRunning = false;
  txnState.snapshotReadInsideChange = undefined;
});

describe('PUT /api/users/:id/update - lockout guard', () => {
  it('rejects an admin demoting their OWN Super Admin role, even when other admins exist', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(5);
    const { res, promise } = run({ user: ADMIN, userId: ADMIN.id, body: { isAdmin: false } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/cannot remove your own/i);
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects demoting the LAST remaining Super Admin (a different user)', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(1);
    const { res, promise } = run({ user: ADMIN, userId: 'other-admin', body: { isAdmin: false } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/last remaining/i);
    expect(mockAdminUpdateUser).not.toHaveBeenCalled();
  });

  it('allows demoting a non-last admin (a different user)', async () => {
    mockUserFindById.mockReturnValue({ isAdmin: true });
    mockCount.mockResolvedValue(2);
    const { res, promise } = run({ user: ADMIN, userId: 'other-admin', body: { isAdmin: false } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalled();
    expect(mockAdminUpdateUser.mock.calls[0][2].db.userApiKeys).toBeDefined();
  });

  it('does not run the lockout check at all for a non-demote update (isAdmin absent from body)', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { tags: ['opti'] } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Only the in-transaction snapshot and the post-update refetch; the guard's isAdmin read
    // is skipped entirely.
    expect(mockUserFindById).toHaveBeenCalledTimes(2);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('does not run the lockout check when promoting a user (isAdmin: true)', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // In-transaction snapshot and refetch; no guard read.
    expect(mockUserFindById).toHaveBeenCalledTimes(2);
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
      body: { currentCredits: 10 },
      apiKeyInfo: { keyId: 'k1', scopes: [ApiKeyScope.ADMIN] },
    });
    await promise;

    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('leaves JWT admins alone - no apiKeyInfo means no scope gate', async () => {
    const { promise } = run({ user: ADMIN, userId: 'someone-else', body: { currentCredits: 10 } });
    await promise;

    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });
});

describe('PUT /api/users/:id/update - admin unknown-field discard', () => {
  it('reports unknown fields instead of silently dropping them', async () => {
    const { res, promise } = run({
      user: ADMIN,
      userId: 'other-user',
      // `adminNote` is the real misnaming that shipped once (see useUpdateUserCredits):
      // the intended field is `creditReason`, so the admin's reason went nowhere.
      body: { currentCredits: 500, adminNote: 'comped', nickname: 'Bob' },
    });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.ignoredFields).toEqual(expect.arrayContaining(['adminNote', 'nickname']));
    expect(json.ignoredFields).toHaveLength(2);

    const [, calledBody] = mockAdminUpdateUser.mock.calls[0];
    expect(calledBody).toEqual({ id: 'other-user', currentCredits: 500 });
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
    mockAdminUpdateUser.mockResolvedValue(written);
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
