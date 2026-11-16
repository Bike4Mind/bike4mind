import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';

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
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@server/admin/adminRoles/adminRoles', () => ({
  getAdminRole: (...args: unknown[]) => mockGet(...args),
  updateAdminRole: (...args: unknown[]) => mockUpdate(...args),
  deleteAdminRole: (...args: unknown[]) => mockDelete(...args),
}));

import handler from '../[id]';
import { FULL_ADMIN, NON_ADMIN, SUPPORT_DELEGATE, call } from './routeHarness';

const ROLE_ID = 'e'.repeat(24);
const query = { id: ROLE_ID };

describe('/api/admin/admin-roles/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ id: ROLE_ID, name: 'Support', memberCount: 1 });
    mockUpdate.mockResolvedValue({ id: ROLE_ID, name: 'Renamed', memberCount: 1 });
    mockDelete.mockResolvedValue(undefined);
  });

  it.each(['GET', 'PATCH', 'DELETE'] as const)('refuses %s from a non-admin', async method => {
    await expect(call(handler, method, NON_ADMIN, { query, body: { name: 'X' } })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('reads a role for a support:read delegate', async () => {
    const res = await call(handler, 'GET', SUPPORT_DELEGATE, { query });
    expect(res._getJSONData()).toEqual({ id: ROLE_ID, name: 'Support', memberCount: 1 });
  });

  it('answers 404 for an id that is not an ObjectId', async () => {
    await expect(call(handler, 'GET', FULL_ADMIN, { query: { id: 'nope' } })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses writes from a delegate without settings:manage', async () => {
    await expect(call(handler, 'PATCH', SUPPORT_DELEGATE, { query, body: { name: 'X' } })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(call(handler, 'DELETE', SUPPORT_DELEGATE, { query })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('passes a full admin edit through to the service', async () => {
    const res = await call(handler, 'PATCH', FULL_ADMIN, {
      query,
      body: { permissions: ['users:moderate', 'support:read'] },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      FULL_ADMIN,
      ROLE_ID,
      { permissions: ['support:read', 'users:moderate'] },
      {}
    );
    expect(res._getJSONData()).toMatchObject({ name: 'Renamed' });
  });

  it('deletes for a full admin', async () => {
    const res = await call(handler, 'DELETE', FULL_ADMIN, { query });
    expect(mockDelete).toHaveBeenCalledWith(FULL_ADMIN, ROLE_ID, {});
    expect(res.statusCode).toBe(204);
  });

  it('hands the service the canonical lowercase id for an uppercase one', async () => {
    await call(handler, 'DELETE', FULL_ADMIN, { query: { id: ROLE_ID.toUpperCase() } });
    expect(mockDelete).toHaveBeenCalledWith(FULL_ADMIN, ROLE_ID, {});
  });
});
