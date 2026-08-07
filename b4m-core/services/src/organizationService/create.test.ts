import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from './create';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';

describe('organizationService - create', () => {
  const mockUser: Partial<IUserDocument> = {
    id: 'user1',
    name: 'Test User',
    email: 'test@example.com',
  };

  // Expected organization structure based on the create function
  const expectedOrganization: Omit<IOrganizationDocument, 'id'> = {
    name: 'Test Organization',
    personal: false,
    userId: 'user1',
    users: [],
    seats: 3,
    description: '',
    billingContact: '',
    userDetails: null,
    groups: [],
    currentCredits: 0,
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: expect.any(Date),
    updatedAt: expect.any(Date),
  };

  let mockAdapters: any;
  let createdOrganization: any;

  beforeEach(() => {
    vi.resetAllMocks();

    // Create a mock organization with an ID (simulating DB creation)
    createdOrganization = {
      ...expectedOrganization,
      id: 'org1',
    };

    mockAdapters = {
      db: {
        organizations: {
          create: vi.fn().mockResolvedValue(createdOrganization),
        },
        users: {
          findById: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue(null),
        },
      },
    };
  });

  it('should create an organization with default values', async () => {
    const result = await create(
      mockUser as IUserDocument,
      { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
      mockAdapters
    );

    expect(result).toEqual(createdOrganization);

    // Verify that the create method was called with the correct parameters
    expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Organization',
        personal: false,
        userId: 'user1',
        seats: 1,
        stripeCustomerId: null,
        users: [],
      })
    );
  });

  it('should create a personal organization when personal flag is true', async () => {
    // Update the expected organization for this test
    const personalOrg = {
      ...createdOrganization,
      name: 'Personal Workspace',
      personal: true,
    };

    // Mock the create method to return the personal organization
    mockAdapters.db.organizations.create.mockResolvedValue(personalOrg);

    // Call the function with personal flag
    const result = await create(
      mockUser as IUserDocument,
      { name: 'Personal Workspace', personal: true, seats: 1, stripeCustomerId: null },
      mockAdapters
    );

    expect(result).toEqual(personalOrg);

    // Verify that the create method was called with the correct parameters
    expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Personal Workspace',
        personal: true,
        seats: 1,
        stripeCustomerId: null,
        userId: 'user1',
      })
    );
  });

  it('should set the userId to the current user ID', async () => {
    // Create a different user
    const differentUser: Partial<IUserDocument> = {
      id: 'user2',
      name: 'Another User',
      email: 'another@example.com',
    };

    // Call the function with a different user
    await create(
      differentUser as IUserDocument,
      { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
      mockAdapters
    );

    // Verify that the create method was called with the correct userId
    expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user2',
      })
    );
  });

  it('should set the creation and update timestamps', async () => {
    // Mock the Date constructor
    const mockDate = new Date('2023-01-01T00:00:00.000Z');
    const originalDate = global.Date;
    global.Date = vi.fn(function () {
      return mockDate;
    }) as any;
    global.Date.now = originalDate.now;

    try {
      await create(
        mockUser as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
        mockAdapters
      );

      // Verify that the create method was called with the correct timestamps
      expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: mockDate,
          updatedAt: mockDate,
        })
      );
    } finally {
      // Restore the original Date constructor
      global.Date = originalDate;
    }
  });

  it('should validate and secure parameters', async () => {
    // Call the function with extra parameters that should be ignored
    await create(
      mockUser as IUserDocument,
      {
        name: 'Test Organization',
        personal: false,
        stripeCustomerId: null,
        seats: 10,
        // @ts-ignore - Adding extra parameters to test parameter validation
        extraParam: 'should be ignored',
      },
      mockAdapters
    );

    // Verify that the create method was called with the correct parameters
    // and that extra parameters were ignored
    expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Organization',
        personal: false,
        seats: 10,
      })
    );

    // Verify that extraParam was not included
    expect(mockAdapters.db.organizations.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        extraParam: 'should be ignored',
      })
    );
  });

  describe('billing-owner active-org context (#1388)', () => {
    it("sets the creating owner's organizationId to the new org when they have none", async () => {
      await create(
        mockUser as IUserDocument, // no organizationId
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
        mockAdapters
      );
      expect(mockAdapters.db.users.update).toHaveBeenCalledWith({ id: 'user1', organizationId: 'org1' });
      // Owner is the caller, so no lookup is needed.
      expect(mockAdapters.db.users.findById).not.toHaveBeenCalled();
    });

    it('does NOT overwrite an owner who already has an active org', async () => {
      await create(
        { ...mockUser, organizationId: 'existing-org' } as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
        mockAdapters
      );
      expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    });

    it('sets the org context on the billing owner (loaded) when billingOwnerId differs from the caller', async () => {
      mockAdapters.db.users.findById.mockResolvedValue({
        id: 'owner2',
        name: 'Owner Two',
        email: 'owner2@example.com',
        organizationId: undefined,
      });
      await create(
        mockUser as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null, billingOwnerId: 'owner2' },
        mockAdapters
      );
      expect(mockAdapters.db.users.findById).toHaveBeenCalledWith('owner2');
      expect(mockAdapters.db.users.update).toHaveBeenCalledWith({ id: 'owner2', organizationId: 'org1' });
    });

    it('leaves an on-behalf owner untouched when they already have an active org', async () => {
      mockAdapters.db.users.findById.mockResolvedValue({
        id: 'owner2',
        name: 'Owner Two',
        email: 'owner2@example.com',
        organizationId: 'owner2-org',
      });
      await create(
        mockUser as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null, billingOwnerId: 'owner2' },
        mockAdapters
      );
      expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    });
  });

  describe('userDetails seeding at create (#1460)', () => {
    it('seeds the credit side-table for the acting user when no billingOwnerId is given', async () => {
      await create(
        mockUser as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null },
        mockAdapters
      );
      expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userDetails: [
            { id: 'user1', email: 'test@example.com', name: 'Test User', usedCredits: 0, lastCreditUsedAt: null },
          ],
        })
      );
    });

    it('seeds the credit side-table for the resolved billing owner, not the acting caller', async () => {
      mockAdapters.db.users.findById.mockResolvedValue({
        id: 'owner2',
        name: 'Owner Two',
        email: 'owner2@example.com',
        organizationId: undefined,
      });
      await create(
        mockUser as IUserDocument,
        { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null, billingOwnerId: 'owner2' },
        mockAdapters
      );
      expect(mockAdapters.db.organizations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner2',
          userDetails: [
            { id: 'owner2', email: 'owner2@example.com', name: 'Owner Two', usedCredits: 0, lastCreditUsedAt: null },
          ],
        })
      );
    });

    it('throws when an explicit billingOwnerId cannot be resolved to a user', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(null);
      await expect(
        create(
          mockUser as IUserDocument,
          { name: 'Test Organization', personal: false, seats: 1, stripeCustomerId: null, billingOwnerId: 'ghost' },
          mockAdapters
        )
      ).rejects.toThrow(/Billing owner ghost not found/);
      expect(mockAdapters.db.organizations.create).not.toHaveBeenCalled();
    });
  });
});
