import { describe, it, expect, vi, beforeEach } from 'vitest';
import { search } from './search';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';

describe('organizationService - search', () => {
  const mockOrganizations: WithId<IOrganizationDocument>[] = [
    {
      id: '1',
      userId: 'user1',
      name: 'Organization 1',
      personal: false,
      description: 'Description 1',
      billingContact: 'contact1@example.com',
      seats: 10,
      currentCredits: 0,
      userDetails: null,
      users: [{ userId: 'user1', permissions: [] }],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      createdAt: new Date('2023-01-01'),
      updatedAt: new Date('2023-01-01'),
    },
    {
      id: '2',
      userId: 'user2',
      name: 'Organization 2',
      personal: true,
      description: 'Description 2',
      billingContact: 'contact2@example.com',
      seats: 5,
      currentCredits: 0,
      userDetails: null,
      users: [{ userId: 'user2', permissions: [] }],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      createdAt: new Date('2023-01-02'),
      updatedAt: new Date('2023-01-02'),
    },
  ];

  let mockAdapters: any;

  beforeEach(() => {
    mockAdapters = {
      db: {
        organizations: {
          search: vi.fn().mockResolvedValue({
            items: mockOrganizations,
            pagination: {
              total: 2,
              page: 1,
              limit: 10,
              totalPages: 1,
            },
          }),
        },
      },
    };
  });

  it('should return organizations with pagination', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    const result = await search(
      mockAdminUser as IUserDocument,
      {
        filters: {},
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(result).toEqual({
      items: mockOrganizations,
      pagination: {
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1,
      },
    });

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      {},
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('should filter by personal organizations', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        filters: { personal: true },
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      { personal: true },
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('should filter by personal organizations using string parameters', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        // @ts-expect-error - This is a test
        filters: { personal: 'true' },
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      { personal: true },
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('should filter by userId organization', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        filters: { userId: 'user1' },
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      { userId: 'user1' },
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('should handle pagination correctly', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        filters: {},
        pagination: { page: 2, limit: 5 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      {},
      { page: 2, limit: 5 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('should handle sorting correctly', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        filters: {},
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'createdAt', direction: 'desc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      '',
      {},
      { page: 1, limit: 10 },
      { field: 'createdAt', direction: 'desc' }
    );
  });

  it('should handle text search query', async () => {
    await search(
      { id: 'user1', isAdmin: true } as IUserDocument,
      {
        filters: {},
        query: 'search term',
        pagination: { page: 1, limit: 10 },
        orderBy: { field: 'name', direction: 'asc' },
      },
      mockAdapters
    );

    expect(mockAdapters.db.organizations.search).toHaveBeenCalledWith(
      'search term',
      {},
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });
});
