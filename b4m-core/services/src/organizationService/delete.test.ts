import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteOrganization } from './delete';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import * as getOrganization from './get';

describe('organizationService - delete', () => {
  let mockAdapters: any;

  const mockOrganization: WithId<IOrganizationDocument> = {
    id: 'org1',
    name: 'Test Organization',
    userId: 'user1',
    personal: false,
    description: 'Test Description',
    billingContact: 'contact@example.com',
    currentCredits: 0,
    seats: 10,
    userDetails: null,
    users: [{ userId: 'user1', permissions: [] }],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  // Create a base mock repository with all required methods
  const createMockRepository = () => ({
    delete: vi.fn(),
    shareable: {
      findAccessibleById: vi.fn(),
    },
  });

  beforeEach(() => {
    mockAdapters = {
      db: {
        organizations: createMockRepository(),
        groups: {
          findByOrganization: vi.fn().mockResolvedValue([]),
          delete: vi.fn(),
        },
        users: {
          removeGroupsFromAllUsers: vi.fn(),
        },
      },
    };
    vi.spyOn(getOrganization, 'get').mockResolvedValue(mockOrganization);
  });

  it('should successfully delete an organization', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  it('should fail if validation fails', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always fails
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false, reason: 'Test validation failure' }),
    };

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      'Organization deletion validation failed: Test validation failure'
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
  });

  it('should fail if validation fails without reason', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always fails without reason
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false }),
    };

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      'Organization deletion validation failed'
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
  });

  it('should succeed if validation passes', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always succeeds
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: true }),
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  it('should proceed with deletion if no validation is provided', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  describe('delete authority', () => {
    // `get` resolves via findAccessibleById, which any member holding read satisfies, so these pin
    // that deletion additionally requires the billing owner or a platform admin.
    it('should allow the billing owner to delete', async () => {
      const owner: Partial<IUserDocument> = { id: 'user1', isAdmin: false };

      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('should reject a read-only member and perform no writes', async () => {
      const member: Partial<IUserDocument> = { id: 'member1', isAdmin: false };
      mockAdapters.validation = { canDeleteOrganization: vi.fn() };

      await expect(deleteOrganization(member as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Not authorized to delete this organization'
      );

      expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
      // The gate precedes the subscription check, so a caller without authority cannot read the
      // org's billing state out of the validation reason.
      expect(mockAdapters.validation.canDeleteOrganization).not.toHaveBeenCalled();
    });

    it('should reject an appointed org admin who is not the billing owner', async () => {
      // orgAdmin1 must ALSO be in users[]: assertCanManageOrgGroups requires adminUserIds AND
      // membership, so a non-member org admin would fail that predicate too and the test would
      // pass even if the gate were consolidated onto it. Membership is what makes this pin the
      // narrowness the gate deliberately keeps.
      vi.spyOn(getOrganization, 'get').mockResolvedValue({
        ...mockOrganization,
        adminUserIds: ['orgAdmin1'],
        users: [...mockOrganization.users, { userId: 'orgAdmin1', permissions: [] }],
      } as WithId<IOrganizationDocument>);
      const orgAdmin: Partial<IUserDocument> = { id: 'orgAdmin1', isAdmin: false };

      await expect(deleteOrganization(orgAdmin as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Not authorized to delete this organization'
      );

      expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
    });
  });

  it('should throw if delete operation fails', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Mock delete to throw an error
    const deleteError = new Error('Failed to delete organization');
    mockAdapters.db.organizations.delete.mockRejectedValue(deleteError);

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      deleteError
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  // Regression coverage for #1219: deleteOrganization previously had NO reference to groups or
  // users at all, so a deleted org's groups stayed live (soft-delete never applied) and every
  // member kept the group ids in user.groups - continuing to satisfy the sharing layer's
  // `groups.$elemMatch.groupId $in user.groups` match against a group whose org no longer exists.
  describe('group footprint purge', () => {
    const mockAdminUser: Partial<IUserDocument> = { id: 'admin1', isAdmin: true };

    it('purges member group ids and soft-deletes the org groups when the org has live groups', async () => {
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([
        { id: 'group-a', type: 'sales' },
        { id: 'group-b', type: 'research' },
      ]);
      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      // includeDeleted so the purge reaches already-soft-deleted groups whose ids may linger (#1230).
      expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1', { includeDeleted: true });
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).toHaveBeenCalledWith(['group-a', 'group-b']);
      // Each group soft-deleted individually via the inherited delete() (#1228 revert of the bulk workaround).
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledTimes(2);
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledWith('group-a');
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledWith('group-b');
      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('purges an already-soft-deleted group id surfaced via includeDeleted (#1230)', async () => {
      // findByOrganization(includeDeleted) returns a stale (previously soft-deleted) group whose id
      // may still sit in user.groups; org deletion must purge it, not just the live groups.
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'stale-group', type: 'sales' }]);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1', { includeDeleted: true });
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).toHaveBeenCalledWith(['stale-group']);
    });

    it('purges membership BEFORE soft-deleting the groups (fail-safe ordering)', async () => {
      const callOrder: string[] = [];
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'group-a', type: 'sales' }]);
      mockAdapters.db.users.removeGroupsFromAllUsers.mockImplementation(async () => {
        callOrder.push('removeGroupsFromAllUsers');
      });
      mockAdapters.db.groups.delete.mockImplementation(async () => {
        callOrder.push('groups.delete');
      });
      mockAdapters.db.organizations.delete.mockImplementation(async () => {
        callOrder.push('organizations.delete');
      });

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(callOrder).toEqual(['removeGroupsFromAllUsers', 'groups.delete', 'organizations.delete']);
    });

    it('does not call the purge or soft-delete when the org has no live groups', async () => {
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([]);
      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
      expect(mockAdapters.db.groups.delete).not.toHaveBeenCalled();
      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('does not purge groups if validation rejects the delete', async () => {
      mockAdapters.validation = {
        canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false, reason: 'blocked' }),
      };
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'group-a', type: 'sales' }]);

      await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Organization deletion validation failed: blocked'
      );

      expect(mockAdapters.db.groups.findByOrganization).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
      expect(mockAdapters.db.groups.delete).not.toHaveBeenCalled();
    });
  });
});
