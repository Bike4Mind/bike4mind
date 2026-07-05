import { describe, it, expect, vi, beforeEach } from 'vitest';
import getUsers from './getUsers';
import { get } from './get';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

vi.mock('./get', () => ({
  get: vi.fn(),
}));

describe('organizationService - getUsers', () => {
  let mockAdapters: any;
  const mockOrganization: WithId<IOrganizationDocument> = {
    id: 'org1',
    name: 'Test Organization',
    personal: false,
    description: 'Test Description',
    billingContact: 'contact@example.com',
    seats: 10,
    currentCredits: 0,
    userId: 'user1',
    userDetails: null,
    users: [
      { userId: 'user2', permissions: [] },
      { userId: 'user3', permissions: [] },
    ],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  // Simplified mock users cast to the required type
  const mockUsers = [
    {
      id: 'user1',
      email: 'user1@example.com',
      name: 'User One',
      isAdmin: false,
    },
    {
      id: 'user2',
      email: 'user2@example.com',
      name: 'User Two',
      isAdmin: false,
    },
    {
      id: 'user3',
      email: 'user3@example.com',
      name: 'User Three',
      isAdmin: false,
    },
  ] as unknown as WithId<IUserDocument>[];

  const createMockUserRepository = () => ({
    findByIds: vi.fn(),
  });

  const createMockOrgRepository = () => ({
    findById: vi.fn(),
    shareable: {
      findAccessibleById: vi.fn(),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (get as any).mockReset();
    mockAdapters = {
      db: {
        organizations: createMockOrgRepository(),
        users: createMockUserRepository(),
      },
    };
  });

  it('should return users for a valid organization', async () => {
    (get as any).mockResolvedValue(mockOrganization);

    mockAdapters.db.users.findByIds.mockResolvedValue(mockUsers);

    const mockUser = { id: 'user1', isAdmin: false } as IUserDocument;

    const result = await getUsers(mockUser, { id: 'org1' }, mockAdapters);

    expect(result).toEqual(mockUsers);
    expect(get).toHaveBeenCalledWith(mockUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.users.findByIds).toHaveBeenCalledWith(['user2', 'user3', 'user1']);
  });

  it('should handle an organization with no users', async () => {
    // Create an organization with no users
    const emptyOrg = { ...mockOrganization, users: [] };

    (get as any).mockResolvedValue(emptyOrg);

    const mockUser = { id: 'admin1', isAdmin: true } as IUserDocument;

    mockAdapters.db.users.findByIds.mockResolvedValue([{ id: 'user1', isAdmin: true }]);
    const result = await getUsers(mockUser, { id: 'org1' }, mockAdapters);

    expect(result).toEqual([{ id: 'user1', isAdmin: true }]);
    expect(get).toHaveBeenCalledWith(mockUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.users.findByIds).toHaveBeenCalledWith(['user1']);
  });

  it('should propagate errors from the get function', async () => {
    (get as any).mockRejectedValue(new NotFoundError('Organization not found'));

    const mockUser = { id: 'user1', isAdmin: false } as IUserDocument;

    await expect(getUsers(mockUser, { id: 'nonexistent' }, mockAdapters)).rejects.toThrow(NotFoundError);

    expect(get).toHaveBeenCalledWith(mockUser, { id: 'nonexistent' }, mockAdapters);
    expect(mockAdapters.db.users.findByIds).not.toHaveBeenCalled();
  });

  it('should handle errors from the findByIds function', async () => {
    (get as any).mockResolvedValue(mockOrganization);

    mockAdapters.db.users.findByIds.mockRejectedValue(new Error('Database error'));

    const mockUser = { id: 'user1', isAdmin: false } as IUserDocument;

    await expect(getUsers(mockUser, { id: 'org1' }, mockAdapters)).rejects.toThrow('Database error');

    expect(get).toHaveBeenCalledWith(mockUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.users.findByIds).toHaveBeenCalledWith(['user2', 'user3', 'user1']);
  });
});
