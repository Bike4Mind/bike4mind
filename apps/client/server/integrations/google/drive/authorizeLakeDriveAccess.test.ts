import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ verifyOrgAccess: vi.fn(), verifyOrgAdminRead: vi.fn() }));

vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: h.verifyOrgAccess,
  verifyOrgAdminRead: h.verifyOrgAdminRead,
}));

import { authorizeLakeDriveAccess, authorizeLakeDriveRead } from './authorizeLakeDriveAccess';
import { NotFoundError } from '@server/utils/errors';

const member = { id: 'u1', isAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyOrgAccess.mockResolvedValue({});
  h.verifyOrgAdminRead.mockResolvedValue({ org: {}, canManage: true });
});

describe('authorizeLakeDriveAccess', () => {
  it('gates an org lake on org owner/manager and returns the org owner', async () => {
    const owner = await authorizeLakeDriveAccess(member, { organizationId: 'org1', createdByUserId: 'someone' });

    expect(h.verifyOrgAccess).toHaveBeenCalledWith(member, 'org1');
    expect(owner).toEqual({ kind: 'organization', organizationId: 'org1' });
  });

  it('propagates an org refusal', async () => {
    h.verifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));

    await expect(
      authorizeLakeDriveAccess(member, { organizationId: 'org1', createdByUserId: 'u1' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([null, '', undefined])('admits the creator of a personal lake (organizationId %j)', async organizationId => {
    const owner = await authorizeLakeDriveAccess(member, { organizationId, createdByUserId: 'u1' });

    expect(owner).toEqual({ kind: 'user', userId: 'u1' });
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });

  it('refuses anyone else on a personal lake - a platform admin included - as a 404', async () => {
    const lake = { organizationId: null, createdByUserId: 'owner' };

    await expect(authorizeLakeDriveAccess(member, lake)).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeLakeDriveAccess({ id: 'admin', isAdmin: true }, lake)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('authorizeLakeDriveRead', () => {
  it('gates an org lake on the read tier, never the write tier, and reports whether the caller can manage', async () => {
    h.verifyOrgAdminRead.mockResolvedValue({ org: {}, canManage: false });

    const result = await authorizeLakeDriveRead(member, { organizationId: 'org1', createdByUserId: 'someone' });

    expect(h.verifyOrgAdminRead).toHaveBeenCalledWith(member, 'org1');
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    expect(result).toEqual({ owner: { kind: 'organization', organizationId: 'org1' }, canManage: false });
  });

  it('propagates an org refusal', async () => {
    h.verifyOrgAdminRead.mockRejectedValue(new NotFoundError('Organization not found'));

    await expect(
      authorizeLakeDriveRead(member, { organizationId: 'org1', createdByUserId: 'u1' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('admits the creator of a personal lake as a manager', async () => {
    const result = await authorizeLakeDriveRead(member, { organizationId: null, createdByUserId: 'u1' });

    expect(result).toEqual({ owner: { kind: 'user', userId: 'u1' }, canManage: true });
    expect(h.verifyOrgAdminRead).not.toHaveBeenCalled();
  });

  it('refuses anyone else on a personal lake - a platform admin included - as a 404', async () => {
    const lake = { organizationId: null, createdByUserId: 'owner' };

    await expect(authorizeLakeDriveRead(member, lake)).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeLakeDriveRead({ id: 'admin', isAdmin: true }, lake)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// authorizeLakeDriveRead restates the personal-lake creator check; this pins the two gates together.
describe('personal-lake parity between the write and read gates', () => {
  it.each([
    { who: 'the creator', user: member, admitted: true },
    { who: 'another user', user: { id: 'other', isAdmin: false }, admitted: false },
    { who: 'a platform admin', user: { id: 'admin', isAdmin: true }, admitted: false },
  ])('treats $who the same on both gates', async ({ user, admitted }) => {
    const lake = { organizationId: null, createdByUserId: 'u1' };
    const writeAdmits = await authorizeLakeDriveAccess(user, lake).then(
      () => true,
      () => false
    );
    const readManages = await authorizeLakeDriveRead(user, lake).then(
      result => result.canManage,
      () => false
    );
    expect(writeAdmits).toBe(admitted);
    expect(readManages).toBe(admitted);
  });
});
