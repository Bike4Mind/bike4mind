import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

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
  },
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => {
      const result = mockUserFindById(...a);
      return { select: () => ({ lean: () => Promise.resolve(result) }) };
    },
  },
  userRepository: { count: (...a: unknown[]) => mockCount(...a) },
  friendshipRepository: {},
  Organization: {},
  withTransaction: (fn: () => unknown) => fn(),
  TelemetryAuditLogModel: { create: vi.fn().mockResolvedValue(undefined) },
}));

import handler from '../update';

const run = ({
  user,
  userId = 'u1',
  body = {},
}: {
  user?: unknown;
  userId?: string;
  body?: Record<string, unknown>;
} = {}) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: userId }, body });
  if (user) (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = { updateMetadata: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockUserFindById.mockReset();
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
