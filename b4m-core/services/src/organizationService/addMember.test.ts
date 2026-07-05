import { addMember } from './addMember';
import { NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { IUserDocument, Permission } from '@bike4mind/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloneDeep } from 'lodash';

describe('addMember', () => {
  const mockOwnerUser = {
    id: 'owner-id',
    name: 'Owner User',
    isAdmin: false,
  } as IUserDocument;

  const mockAdminUser = {
    id: 'admin-id',
    name: 'Admin User',
    isAdmin: true,
  } as IUserDocument;

  const mockUser = {
    id: 'user-id',
    name: 'Test User',
    email: 'test@example.com',
  };

  const mockOrganization = {
    id: 'org-id',
    name: 'Test Organization',
    seats: 5,
    users: [],
  };

  let mockAdapters: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        users: {
          findById: vi.fn(),
          findByEmail: vi.fn(),
          update: vi.fn(),
        },
        organizations: {
          findById: vi.fn(),
          update: vi.fn(),
          shareable: {
            findAccessibleById: vi.fn(),
          },
        },
      },
      logger: {
        info: vi.fn(),
      },
    };
  });

  it('should throw NotFoundError if user is not found by ID', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(
      addMember(mockOwnerUser, { userId: 'non-existent-user', organizationId: 'org-id' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith('non-existent-user');
  });

  it('should throw NotFoundError if user is not found by email', async () => {
    mockAdapters.db.users.findByEmail.mockResolvedValue(null);
    await expect(
      addMember(mockOwnerUser, { email: 'nonexistent@example.com', organizationId: 'org-id' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.findByEmail).toHaveBeenCalledWith('nonexistent@example.com');
  });

  it('should throw NotFoundError if organization is not found for regular user', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);

    await expect(
      addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'non-existent-org' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith('user-id');
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(
      mockOwnerUser,
      'non-existent-org'
    );
    expect(mockAdapters.db.organizations.findById).not.toHaveBeenCalled();
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should allow admin users to access organization even if not directly accessible', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);

    const result = await addMember(mockAdminUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockAdminUser, 'org-id');
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org-id');
    expect(mockAdapters.logger.info).toHaveBeenCalledWith(
      `User ${mockAdminUser.id} is an admin, accessing organization org-id`
    );
    expect(result).toEqual({
      organization: {
        ...mockOrganization,
        users: [{ userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
  });

  it('should throw NotFoundError if organization is not found even for admin user', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);
    mockAdapters.db.organizations.findById.mockResolvedValue(null);

    await expect(
      addMember(mockAdminUser, { userId: 'user-id', organizationId: 'non-existent-org' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(
      mockAdminUser,
      'non-existent-org'
    );
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('non-existent-org');
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should throw UnprocessableEntityError if organization is at full capacity', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue({
      ...mockOrganization,
      seats: 2,
      users: [{ userId: 'user-1' }, { userId: 'user-2' }],
    });
    await expect(
      addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters)
    ).rejects.toThrow(UnprocessableEntityError);
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should add user to organization if force is true even if at capacity', async () => {
    const orgWithUsers = {
      ...mockOrganization,
      seats: 2,
      users: [{ userId: 'user-1' }, { userId: 'user-2' }],
    };
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(cloneDeep(orgWithUsers));

    const result = await addMember(
      mockOwnerUser,
      { userId: 'user-id', organizationId: 'org-id', force: true },
      mockAdapters
    );

    expect(result).toEqual({
      organization: {
        ...orgWithUsers,
        users: [...orgWithUsers.users, { userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });

  it('should return updated organization and user if user is already in the organization', async () => {
    const orgWithUser = {
      ...mockOrganization,
      users: [{ userId: 'user-id', permissions: [] }],
    };
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(orgWithUser);

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result).toEqual({
      organization: {
        ...orgWithUser,
        users: [{ userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });

  it('should add user to organization successfully using userId', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(mockOrganization);

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result).toEqual({
      organization: {
        ...mockOrganization,
        users: [{ userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith({
      ...mockOrganization,
      users: [{ userId: 'user-id', permissions: [Permission.read] }],
    });
  });

  it("should set the added user's organizationId and persist the user", async () => {
    const freshUser = { id: 'user-id', name: 'Test User', email: 'test@example.com', organizationId: null };
    mockAdapters.db.users.findById.mockResolvedValue(freshUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(cloneDeep(mockOrganization));

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result.user.organizationId).toBe('org-id');
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-id', organizationId: 'org-id' })
    );
  });

  it('should set organizationId even when the user is already a member', async () => {
    const freshUser = { id: 'user-id', name: 'Test User', email: 'test@example.com', organizationId: null };
    mockAdapters.db.users.findById.mockResolvedValue(freshUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue({
      ...cloneDeep(mockOrganization),
      users: [{ userId: 'user-id', permissions: [] }],
    });

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result.user.organizationId).toBe('org-id');
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-id', organizationId: 'org-id' })
    );
  });

  it('should not persist the user when the organization is at full capacity', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue({
      ...mockOrganization,
      seats: 2,
      users: [{ userId: 'user-1' }, { userId: 'user-2' }],
    });

    await expect(
      addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters)
    ).rejects.toThrow(UnprocessableEntityError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('should add user to organization successfully using email', async () => {
    mockAdapters.db.users.findByEmail.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(mockOrganization);

    const result = await addMember(
      mockOwnerUser,
      { email: 'test@example.com', organizationId: 'org-id' },
      mockAdapters
    );

    expect(result).toEqual({
      organization: {
        ...mockOrganization,
        users: [{ userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith({
      ...mockOrganization,
      users: [{ userId: 'user-id', permissions: [Permission.read] }],
    });
  });
});
