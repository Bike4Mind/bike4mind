import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Org manager (adminUserIds) permissions in organizationService.update and revokeAccess. */

// Import the REAL organizationService functions
import { organizationService } from '@bike4mind/services';
import { IUserDocument, IOrganizationDocument } from '@bike4mind/common';

describe('organizationService.update - Manager Permissions', () => {
  const mockBillingOwner: Partial<IUserDocument> = {
    id: 'owner-456',
    name: 'Billing Owner',
    email: 'owner@example.com',
    isAdmin: false,
  };

  const mockManager: Partial<IUserDocument> = {
    id: 'manager-789',
    name: 'Team Manager',
    email: 'manager@example.com',
    isAdmin: false,
  };

  const mockOrganization: Partial<IOrganizationDocument> = {
    id: 'org-123',
    name: 'Test Organization',
    description: 'Test description',
    billingContact: 'billing@example.com',
    userId: mockBillingOwner.id,
    adminUserIds: [mockManager.id!],
    users: [{ userId: mockManager.id!, permissions: ['read'] as never }],
  };

  let mockOrganizationRepository: any;

  beforeEach(() => {
    mockOrganizationRepository = {
      shareable: {
        findUpdateAccessById: vi.fn().mockResolvedValue(mockOrganization),
      },
      // Mirror findOneAndUpdate({ new: true }): the real repo returns the full merged
      // document, not just the $set partial the service now passes.
      update: vi.fn().mockImplementation(org => Promise.resolve({ ...mockOrganization, ...org })),
      findById: vi.fn().mockResolvedValue(mockOrganization),
    };
  });

  describe('Manager can update organization fields', () => {
    it('should allow manager to update name', async () => {
      const result = await organizationService.update(
        mockManager as IUserDocument,
        {
          id: mockOrganization.id!,
          name: 'Updated Name',
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      expect(result.name).toBe('Updated Name');
      expect(mockOrganizationRepository.update).toHaveBeenCalled();
    });

    it('should allow manager to update description', async () => {
      const result = await organizationService.update(
        mockManager as IUserDocument,
        {
          id: mockOrganization.id!,
          description: 'Updated description',
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      expect(result.description).toBe('Updated description');
      expect(mockOrganizationRepository.update).toHaveBeenCalled();
    });
  });

  describe('Manager cannot update billing fields', () => {
    it('should prevent manager from updating billingContact', async () => {
      const result = await organizationService.update(
        mockManager as IUserDocument,
        {
          id: mockOrganization.id!,
          billingContact: 'hacker@example.com',
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      // billingContact should remain unchanged
      expect(result.billingContact).toBe(mockOrganization.billingContact);
      expect(result.billingContact).not.toBe('hacker@example.com');
    });
  });

  describe('Owner can update all fields', () => {
    it('should allow owner to update billingContact', async () => {
      const result = await organizationService.update(
        mockBillingOwner as IUserDocument,
        {
          id: mockOrganization.id!,
          billingContact: 'newbilling@example.com',
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      expect(result.billingContact).toBe('newbilling@example.com');
    });
  });
});

describe('organizationService.revokeAccess - Manager Permissions', () => {
  const mockBillingOwner: Partial<IUserDocument> = {
    id: 'owner-456',
    name: 'Billing Owner',
    email: 'owner@example.com',
  };

  const mockManager: Partial<IUserDocument> = {
    id: 'manager-789',
    name: 'Team Manager',
    email: 'manager@example.com',
  };

  const mockMember: Partial<IUserDocument> = {
    id: 'member-111',
    name: 'Team Member',
    email: 'member@example.com',
  };

  const mockOrganization: Partial<IOrganizationDocument> = {
    id: 'org-123',
    name: 'Test Organization',
    userId: mockBillingOwner.id,
    adminUserIds: [mockManager.id!],
    users: [
      { userId: mockManager.id!, permissions: ['read'] as never },
      { userId: mockMember.id!, permissions: [] as never },
    ],
    userDetails: [
      {
        id: mockMember.id!,
        name: mockMember.name!,
        email: mockMember.email!,
        usedCredits: 0,
        lastCreditUsedAt: null,
      },
    ],
  };

  let mockOrganizationRepository: any;
  let mockGroupRepository: any;
  let mockUserRepository: any;
  let mockLakeRepositories: any;

  beforeEach(() => {
    mockOrganizationRepository = {
      findById: vi.fn().mockResolvedValue({ ...mockOrganization }),
      removeMember: vi.fn().mockResolvedValue(undefined),
    };
    // revokeAccess now purges the removed member's org group ids + adminUserIds (org-groups #1172),
    // and clears their organizationId when it pointed at this org (findById returns null here, so
    // that clear is a no-op for these cases).
    mockGroupRepository = { findByOrganization: vi.fn().mockResolvedValue([]) };
    mockUserRepository = {
      removeGroupsFromUser: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
    };
    // revokeAccess also ends the removed member's data-lake access on this org's lakes. No org
    // lakes here, so that step is a no-op and the assertions below stay about membership.
    mockLakeRepositories = {
      dataLakes: {
        findByOrganizationId: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockImplementation(async (input: { id: string }) => ({ id: input.id })),
      },
      dataLakeAccessGrants: {
        listByPrincipal: vi.fn().mockResolvedValue([]),
        listActiveByLakes: vi.fn().mockResolvedValue([]),
        upsertGrant: vi.fn().mockResolvedValue(undefined),
      },
      lakeConfigChangeEvents: { record: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it('should allow manager to revoke access from members', async () => {
    const result = await organizationService.revokeAccess(
      mockManager as IUserDocument,
      {
        id: mockOrganization.id!,
        userId: mockMember.id!,
      },
      {
        db: {
          organizations: mockOrganizationRepository,
          groups: mockGroupRepository,
          users: mockUserRepository,
          ...mockLakeRepositories,
        },
      }
    );

    expect(mockOrganizationRepository.removeMember).toHaveBeenCalled();
    expect(result.users.map(u => u.userId)).toEqual([mockManager.id]);
    expect(result.userDetails).toHaveLength(0);
  });

  it('should prevent non-manager/non-owner from revoking access', async () => {
    const randomUser: Partial<IUserDocument> = {
      id: 'random-999',
      name: 'Random User',
    };

    await expect(
      organizationService.revokeAccess(
        randomUser as IUserDocument,
        {
          id: mockOrganization.id!,
          userId: mockMember.id!,
        },
        {
          db: {
            organizations: mockOrganizationRepository,
            groups: mockGroupRepository,
            users: mockUserRepository,
            ...mockLakeRepositories,
          },
        }
      )
    ).rejects.toThrow('Organization not found');
  });

  it('should allow owner to revoke access from members', async () => {
    const result = await organizationService.revokeAccess(
      mockBillingOwner as IUserDocument,
      {
        id: mockOrganization.id!,
        userId: mockMember.id!,
      },
      {
        db: {
          organizations: mockOrganizationRepository,
          groups: mockGroupRepository,
          users: mockUserRepository,
          ...mockLakeRepositories,
        },
      }
    );

    expect(mockOrganizationRepository.removeMember).toHaveBeenCalled();
    expect(result.users.map(u => u.userId)).toEqual([mockManager.id]);
  });
});
