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
});
