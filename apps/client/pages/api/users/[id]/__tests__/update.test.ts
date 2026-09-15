import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';

const { mockUserFindById, mockAdminUpdateUser, mockUpdateUser, mockCount } = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockAdminUpdateUser: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockCount: vi.fn(),
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

vi.mock('@bike4mind/services', () => ({
  userService: {
    adminUpdateUser: (...a: unknown[]) => mockAdminUpdateUser(...a),
    updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    adminUpdateUserSchema: z.object({}).passthrough(),
    // A real allowlist (not passthrough) so the discarded-field detection under
    // test actually exercises Zod's strip-unknown-keys behavior.
    updateUserSchema: z.object({ name: z.string().optional(), role: z.string().optional() }),
  },
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => {
      const result = mockUserFindById(...a);
      // Mirrors Mongoose's Query: chainable via .select()/.lean(), but also
      // directly awaitable (the handler awaits User.findById(userId) bare in
      // its post-update refetch), so `then` needs to resolve to the same result.
      const query = {
        select: () => query,
        lean: () => Promise.resolve(result),
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
  });

  it('does not run the lockout check at all for a non-demote update (isAdmin absent from body)', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { tags: ['opti'] } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Called once for the post-update refetch, NOT again from inside the lockout guard.
    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    expect(mockAdminUpdateUser).toHaveBeenCalled();
  });

  it('does not run the lockout check when promoting a user (isAdmin: true)', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'other-user', body: { isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindById).toHaveBeenCalledTimes(1);
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
    const { res, promise } = run({
      user: ADMIN,
      userId: 'someone-else',
      body: { currentCredits: 999999 },
      apiKeyInfo: { keyId: 'k1', scopes: [ApiKeyScope.AI_CHAT] },
    });
    await promise;

    expect(res._getStatusCode()).toBe(403);
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
});
