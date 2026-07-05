import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests the managerId field in organizationService.create
 * (b4m-core/services/src/organizationService/create.ts).
 */

// Import the REAL organizationService functions
import { organizationService } from '@bike4mind/services';
import { IUserDocument, IOrganizationDocument } from '@bike4mind/common';

describe('organizationService.create - Team Manager Field', () => {
  const mockUser: Partial<IUserDocument> = {
    id: 'user-123',
    name: 'Test User',
    email: 'test@example.com',
  };

  const mockBillingOwner = {
    id: 'owner-456',
    name: 'Billing Owner',
    email: 'owner@example.com',
  };

  const mockManager = {
    id: 'manager-789',
    name: 'Team Manager',
    email: 'manager@example.com',
  };

  let mockOrganizationRepository: any;

  beforeEach(() => {
    mockOrganizationRepository = {
      create: vi.fn().mockImplementation(org => Promise.resolve({ ...org, id: 'org-created-123' })),
    };
  });

  describe('managerId parameter support', () => {
    it('should set managerId when provided', async () => {
      const result = await organizationService.create(
        mockUser as IUserDocument,
        {
          name: 'Test Org',
          seats: 5,
          personal: false,
          stripeCustomerId: null,
          billingOwnerId: mockBillingOwner.id,
          managerId: mockManager.id,
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      // Verify the create function was called with managerId
      expect(mockOrganizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          managerId: mockManager.id,
          userId: mockBillingOwner.id, // billingOwnerId maps to userId
        })
      );

      // Verify the returned organization has managerId
      expect(result.managerId).toBe(mockManager.id);
    });

    it('should set managerId to null when not provided', async () => {
      const result = await organizationService.create(
        mockUser as IUserDocument,
        {
          name: 'Test Org',
          seats: 5,
          personal: false,
          stripeCustomerId: null,
          billingOwnerId: mockBillingOwner.id,
          // No managerId provided
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      // Verify managerId is null when not provided
      expect(mockOrganizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          managerId: null,
        })
      );

      expect(result.managerId).toBeNull();
    });

    it('should default userId to user.id when billingOwnerId not provided', async () => {
      const result = await organizationService.create(
        mockUser as IUserDocument,
        {
          name: 'Test Org',
          seats: 5,
          personal: false,
          stripeCustomerId: null,
          managerId: mockManager.id,
          // No billingOwnerId - should default to mockUser.id
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      // Verify userId defaults to the user parameter when billingOwnerId not provided
      expect(mockOrganizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          managerId: mockManager.id,
        })
      );

      expect(result.userId).toBe(mockUser.id);
      expect(result.managerId).toBe(mockManager.id);
    });

    it('should create organization with both billingOwnerId and managerId', async () => {
      const result = await organizationService.create(
        mockUser as IUserDocument,
        {
          name: 'Test Org with Manager',
          seats: 10,
          personal: false,
          stripeCustomerId: null,
          billingOwnerId: mockBillingOwner.id,
          managerId: mockManager.id,
        },
        {
          db: {
            organizations: mockOrganizationRepository,
          },
        }
      );

      // Verify both fields are set correctly
      expect(result.userId).toBe(mockBillingOwner.id);
      expect(result.managerId).toBe(mockManager.id);
      expect(result.name).toBe('Test Org with Manager');
      expect(result.seats).toBe(10);
    });
  });

  describe('Validation rules', () => {
    it('should validate managerId !== userId (billing owner)', async () => {
      // Manager cannot be the same as the billing owner
      await expect(
        organizationService.create(
          mockUser as IUserDocument,
          {
            name: 'Test Org',
            seats: 5,
            personal: false,
            stripeCustomerId: null,
            billingOwnerId: mockBillingOwner.id,
            managerId: mockBillingOwner.id, // Same as owner - should fail
          },
          {
            db: {
              organizations: mockOrganizationRepository,
            },
          }
        )
      ).rejects.toThrow('Manager cannot be the same as the billing owner');
    });
  });
});

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
    managerId: mockManager.id,
  };

  let mockOrganizationRepository: any;

  beforeEach(() => {
    mockOrganizationRepository = {
      shareable: {
        findUpdateAccessById: vi.fn().mockResolvedValue(mockOrganization),
      },
      update: vi.fn().mockImplementation(org => Promise.resolve(org)),
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
    managerId: mockManager.id,
    users: [{ userId: mockMember.id!, permissions: [] as any }],
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

  beforeEach(() => {
    mockOrganizationRepository = {
      findById: vi.fn().mockResolvedValue({ ...mockOrganization }),
      update: vi.fn().mockImplementation(org => Promise.resolve(org)),
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
        },
      }
    );

    expect(mockOrganizationRepository.update).toHaveBeenCalled();
    expect(result.users).toHaveLength(0);
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
        },
      }
    );

    expect(mockOrganizationRepository.update).toHaveBeenCalled();
    expect(result.users).toHaveLength(0);
  });
});
