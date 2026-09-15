import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from './get';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('organizationService - get', () => {
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
    findById: vi.fn(),
    shareable: {
      findAccessibleById: vi.fn(),
    },
  });

  beforeEach(() => {
    mockAdapters = {
      db: {
        organizations: createMockRepository(),
      },
    };
  });

  it('should return an organization when found as admin', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);

    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    const result = await get(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(result).toEqual(mockOrganization);
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockAdminUser, 'org1');
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org1');
  });

  it('should throw NotFoundError when organization does not exist', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);
    mockAdapters.db.organizations.findById.mockResolvedValue(null);

    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    await expect(get(mockAdminUser as IUserDocument, { id: 'nonexistent' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(
      mockAdminUser,
      'nonexistent'
    );
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('nonexistent');
  });

  it('should allow access for a user who belongs to the organization', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(mockOrganization);

    // Create a mock user who belongs to the organization
    const mockUser: Partial<IUserDocument> = {
      id: 'user1',
      isAdmin: false,
    };

    const result = await get(mockUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(result).toEqual(mockOrganization);
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockUser, 'org1');
    expect(mockAdapters.db.organizations.findById).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError for a user who does not belong to the organization', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);

    // Create a mock user who does not belong to the organization
    const mockUser: Partial<IUserDocument> = {
      id: 'user2',
      isAdmin: false,
    };

    await expect(get(mockUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockUser, 'org1');
    expect(mockAdapters.db.organizations.findById).not.toHaveBeenCalled();
  });
});
