import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ verifyOrgAccess: vi.fn() }));

vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));

import { authorizeLakeDriveAccess } from './authorizeLakeDriveAccess';
import { NotFoundError } from '@server/utils/errors';

const member = { id: 'u1', isAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyOrgAccess.mockResolvedValue({});
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
