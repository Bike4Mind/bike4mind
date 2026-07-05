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
          findById: vi.fn().mockResolvedValue(existingOrganization),
          update: vi.fn().mockResolvedValue(undefined),
        },
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
    };

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(expectedUpdatedOrg);
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
