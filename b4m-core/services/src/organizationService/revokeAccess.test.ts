import { describe, it, expect, vi, beforeEach } from 'vitest';
import { revokeAccess } from './revokeAccess';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { Permission } from '@bike4mind/common';

describe('organizationService - revokeAccess', () => {
  const mockOwnerUser: Partial<IUserDocument> = {
    id: 'owner1',
    name: 'Owner User',
    email: 'owner@example.com',
  };

  const userToRevoke = {
    userId: 'user1',
    name: 'Regular User',
    email: 'user@example.com',
    permissions: [Permission.read, Permission.update],
  };

  const secondUser = {
    userId: 'user2',
    name: 'Second User',
    email: 'second@example.com',
    permissions: [Permission.read],
  };

  const existingOrganization: Partial<IOrganizationDocument> = {
    id: 'org1',
    name: 'Test Organization',
    description: 'Test description',
    userId: 'owner1',
    users: [userToRevoke, secondUser],
    userDetails: [
      { id: 'user1', name: 'Regular User', email: 'user@example.com', usedCredits: 0, lastCreditUsedAt: null },
      { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
    ],
    seats: 3,
    personal: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  let mockAdapters: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        organizations: {
          // A FRESH copy per test. `revokeAccess` reassigns `organization.users`/`userDetails` on
          // the document it is handed, so returning the shared module-level fixture let the first
          // test strip `user1` from it for every test that ran after - which stayed invisible only
          // while nothing read the roster before filtering it.
          findById: vi.fn().mockResolvedValue({
            ...existingOrganization,
            users: [...existingOrganization.users!],
            userDetails: [...existingOrganization.userDetails!],
          }),
          update: vi.fn().mockResolvedValue(undefined),
        },
        groups: {
          findByOrganization: vi.fn().mockResolvedValue([]),
        },
        users: {
          removeGroupsFromUser: vi.fn().mockResolvedValue(undefined),
          // Default: the removed user has no home-org pointer, so the clear below is a no-op and the
          // org-update assertions in the existing cases stay exact. Cases that exercise the clear
          // override findById.
          findById: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue(undefined),
        },
        // No org lakes by default, so the lake-access lapse is a no-op unless a test sets some and
        // the org-update assertions in the existing cases stay exact.
        dataLakes: {
          findByOrganizationId: vi.fn().mockResolvedValue([]),
        },
        dataLakeAccessGrants: {
          listByPrincipal: vi.fn().mockResolvedValue([]),
          listActiveByLakes: vi.fn().mockResolvedValue([]),
          upsertGrant: vi.fn().mockResolvedValue(undefined),
        },
        lakeConfigChangeEvents: { record: vi.fn().mockResolvedValue(undefined) },
      },
    };
  });

  it('should revoke access for a user from the organization', async () => {
    const revokeParams = {
      id: 'org1',
      userId: 'user1',
    };

    await revokeAccess(mockOwnerUser as IUserDocument, revokeParams, mockAdapters);

    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org1');

    const expectedUpdatedOrg = {
      ...existingOrganization,
      users: [secondUser],
      userDetails: [
        { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
      ],
      adminUserIds: [], // purge normalizes adminUserIds (none appointed here)
    };

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(expectedUpdatedOrg);
  });

  it('purges the removed user group ids and drops them from adminUserIds', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue({
      ...existingOrganization,
      users: [userToRevoke, secondUser],
      userDetails: existingOrganization.userDetails?.map(d => ({ ...d })),
      adminUserIds: ['user1', 'user2'],
    });
    mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'g-a' }, { id: 'g-b' }]);

    const result = await revokeAccess(mockOwnerUser as IUserDocument, { id: 'org1', userId: 'user1' }, mockAdapters);

    expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1');
    expect(mockAdapters.db.users.removeGroupsFromUser).toHaveBeenCalledWith('user1', ['g-a', 'g-b']);
    expect(result.adminUserIds).toEqual(['user2']);
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserIds: ['user2'] })
    );
  });

  // Load-bearing: without it this file merely mocks the lake repos away, and the departure-side
  // trigger could be deleted from revokeAccess.ts with every test here still green.
  it('lapses the removed user lake grants and passes on a lake they created', async () => {
    mockAdapters.db.dataLakes.findByOrganizationId.mockResolvedValue([
      { id: 'lake1', name: 'Team Lake', organizationId: 'org1', createdByUserId: 'user1' },
    ]);
    mockAdapters.db.dataLakeAccessGrants.listByPrincipal.mockResolvedValue([
      { dataLakeId: 'lake1', principalType: 'user', principalId: 'user1', role: 'owner', expiresAt: null },
    ]);

    await revokeAccess(mockOwnerUser as IUserDocument, { id: 'org1', userId: 'user1' }, mockAdapters);

    expect(mockAdapters.db.dataLakes.findByOrganizationId).toHaveBeenCalledWith('org1');
    expect(mockAdapters.db.dataLakeAccessGrants.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'user1', expiresAt: expect.any(Date) })
    );
    // The removing admin is the attributed principal on both writes.
    expect(mockAdapters.db.dataLakeAccessGrants.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake1',
        principalId: 'owner1',
        role: 'owner',
        grantedByUserId: 'owner1',
        expiresAt: null,
      })
    );
  });

  it('should throw NotFoundError when organization is not found', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(null);

    await expect(
      revokeAccess(mockOwnerUser as IUserDocument, { id: 'nonexistent-org', userId: 'user1' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should allow manager to revoke access', async () => {
    const orgWithManager = {
      ...existingOrganization,
      managerId: 'manager1',
    };

    mockAdapters.db.organizations.findById.mockResolvedValue(orgWithManager);

    const mockManagerUser: Partial<IUserDocument> = {
      id: 'manager1',
      name: 'Manager User',
      email: 'manager@example.com',
    };

    const revokeParams = {
      id: 'org1',
      userId: 'user1',
    };

    await revokeAccess(mockManagerUser as IUserDocument, revokeParams, mockAdapters);

    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org1');

    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });

  it('should throw NotFoundError when the user is not owner or manager', async () => {
    const revokeParams = {
      id: 'org1',
      userId: 'user1',
    };

    const unauthorizedUser: Partial<IUserDocument> = {
      id: 'unauthorized-user',
      name: 'Unauthorized User',
      email: 'unauthorized@example.com',
    };

    await expect(revokeAccess(unauthorizedUser as IUserDocument, revokeParams, mockAdapters)).rejects.toThrow(
      NotFoundError
    );

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a target who is not a member, without lapsing any of their lake grants', async () => {
    // The roster filter is a no-op for a non-member, so nothing here would have failed loudly. What
    // makes it matter is the purge: an authorized org admin naming an arbitrary userId must not be
    // able to expire that user's grants on this org's lakes.
    mockAdapters.db.dataLakes.findByOrganizationId.mockResolvedValue([
      { id: 'lake1', organizationId: 'org1', createdByUserId: 'outsider' },
    ]);

    await expect(
      revokeAccess(mockOwnerUser as IUserDocument, { id: 'org1', userId: 'outsider' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
    expect(mockAdapters.db.users.removeGroupsFromUser).not.toHaveBeenCalled();
    expect(mockAdapters.db.dataLakeAccessGrants.upsertGrant).not.toHaveBeenCalled();
  });

  it('should initialize userDetails if it is null', async () => {
    const orgWithoutUserDetails = {
      ...existingOrganization,
      userDetails: null,
    };

    mockAdapters.db.organizations.findById.mockResolvedValue(orgWithoutUserDetails);

    const revokeParams = {
      id: 'org1',
      userId: 'user1',
    };

    await revokeAccess(mockOwnerUser as IUserDocument, revokeParams, mockAdapters);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        userDetails: [],
        users: [secondUser],
      })
    );
  });

  it('clears the removed user organizationId when it pointed at this org (stale-org billing fix)', async () => {
    mockAdapters.db.users.findById.mockResolvedValue({ id: 'user1', organizationId: 'org1' });

    await revokeAccess(mockOwnerUser as IUserDocument, { id: 'org1', userId: 'user1' }, mockAdapters);

    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith('user1');
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith({ id: 'user1', organizationId: null });
  });

  it('leaves the removed user organizationId alone when it points at a different org', async () => {
    mockAdapters.db.users.findById.mockResolvedValue({ id: 'user1', organizationId: 'other-org' });

    await revokeAccess(mockOwnerUser as IUserDocument, { id: 'org1', userId: 'user1' }, mockAdapters);

    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('should validate and secure parameters', async () => {
    const revokeParams = {
      id: 'org1',
      userId: 'user1',
      // @ts-ignore - Adding extra parameters to test parameter validation
      extraParam: 'should be ignored',
    };

    await revokeAccess(mockOwnerUser as IUserDocument, revokeParams, mockAdapters);

    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org1');

    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });
});
