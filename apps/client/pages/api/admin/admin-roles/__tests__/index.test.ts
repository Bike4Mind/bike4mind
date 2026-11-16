import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', async () => ({ baseApi: (await import('./routeHarness')).fakeBaseApi }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/admin/adminRoles/adapters', () => ({
  ADMIN_ROLES_RATE_LIMIT: { limit: 60, windowMs: 60_000, bucket: 'admin-roles' },
  adminRolesDeps: () => ({}),
}));
const mockList = vi.fn();
const mockCreate = vi.fn();
vi.mock('@server/admin/adminRoles/adminRoles', () => ({
  listAdminRoles: (...args: unknown[]) => mockList(...args),
  createAdminRole: (...args: unknown[]) => mockCreate(...args),
}));

import handler from '../index';
import { FULL_ADMIN, NON_ADMIN, ROLE_ONLY_SUPPORT, SUPPORT_DELEGATE, call } from './routeHarness';

describe('/api/admin/admin-roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([{ id: 'r', name: 'Support', memberCount: 2 }]);
    mockCreate.mockResolvedValue({ id: 'r', name: 'Billing', memberCount: 0 });
  });

  it('is a JWT-only admin route', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      allowedMethods: ['GET', 'POST'],
    });
  });

  it('refuses a non-admin', async () => {
    await expect(call(handler, 'GET', NON_ADMIN)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockList).not.toHaveBeenCalled();
  });

  it.each([
    ['a full admin', FULL_ADMIN],
    ['a support:read delegate', SUPPORT_DELEGATE],
    ['a delegate holding support:read through a role', ROLE_ONLY_SUPPORT],
  ])('lists roles for %s', async (_label, user) => {
    const res = await call(handler, 'GET', user);
    expect(res._getJSONData()).toEqual({ roles: [{ id: 'r', name: 'Support', memberCount: 2 }] });
  });

  it('refuses a create from a delegate without settings:manage', async () => {
    await expect(
      call(handler, 'POST', SUPPORT_DELEGATE, { body: { name: 'X', permissions: ['support:read'] } })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates a role for a full admin from a validated body', async () => {
    const res = await call(handler, 'POST', FULL_ADMIN, {
      body: { name: 'Billing', permissions: ['credits:adjust', 'support:read'] },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      FULL_ADMIN,
      { name: 'Billing', description: '', permissions: ['support:read', 'credits:adjust'] },
      {}
    );
  });

  it('rejects a body that tries to carry isAdmin', async () => {
    await expect(
      call(handler, 'POST', FULL_ADMIN, { body: { name: 'Root', permissions: ['support:read'], isAdmin: true } })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
