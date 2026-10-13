import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from './get';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

describe('organizationService - get', () => {
  const repository = {
    findById: vi.fn(),
    shareable: { findAccessibleById: vi.fn() },
  };
  const mockAdapters = { db: { organizations: repository } } as unknown as Parameters<typeof get>[2];

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

  beforeEach(() => {
    repository.findById.mockReset();
    repository.shareable.findAccessibleById.mockReset();
  });

  it('should return an organization when found as admin', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue(mockOrganization);

    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    const result = await get(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(result).toEqual(mockOrganization);
    expect(repository.shareable.findAccessibleById).toHaveBeenCalledWith(mockAdminUser, 'org1');
    expect(repository.findById).toHaveBeenCalledWith('org1');
  });

  it('should throw NotFoundError when organization does not exist', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue(null);

    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    await expect(get(mockAdminUser as IUserDocument, { id: 'nonexistent' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );
    expect(repository.shareable.findAccessibleById).toHaveBeenCalledWith(mockAdminUser, 'nonexistent');
    expect(repository.findById).toHaveBeenCalledWith('nonexistent');
  });

  it('should allow access for a user who belongs to the organization', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(mockOrganization);

    // Create a mock user who belongs to the organization
    const mockUser: Partial<IUserDocument> = {
      id: 'user1',
      isAdmin: false,
    };

    const result = await get(mockUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(result).toEqual(mockOrganization);
    expect(repository.shareable.findAccessibleById).toHaveBeenCalledWith(mockUser, 'org1');
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('admits an appointed manager without a membership row', async () => {
    const organization = { ...mockOrganization, managerId: 'manager1', users: [] };
    const manager = { id: 'manager1', isAdmin: false } as IUserDocument;
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue(organization);

    await expect(get(manager, { id: 'org1' }, mockAdapters)).resolves.toEqual(organization);
    expect(repository.findById).toHaveBeenCalledWith('org1');
  });

  // Both repository lookups answer null for an id that cannot address a row, so the manager
  // fallback must collapse to NotFoundError rather than surface a CastError as a 500.
  it('answers NotFoundError for an uncastable id when both lookups report no row', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue(null);
    const stranger = { id: 'user2', isAdmin: false } as IUserDocument;

    await expect(get(stranger, { id: 'not-an-object-id' }, mockAdapters)).rejects.toThrow(NotFoundError);
    expect(repository.findById).toHaveBeenCalledWith('not-an-object-id');
  });

  it('does not let an empty managerId admit a caller with an empty id', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue({ ...mockOrganization, managerId: '' });
    const emptyIdCaller = { id: '', isAdmin: false } as IUserDocument;

    await expect(get(emptyIdCaller, { id: 'org1' }, mockAdapters)).rejects.toThrow(NotFoundError);
  });

  it('does not collapse a failed fallback lookup into NotFoundError', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockRejectedValue(new Error('connection lost'));
    const stranger = { id: 'user2', isAdmin: false } as IUserDocument;

    await expect(get(stranger, { id: 'org1' }, mockAdapters)).rejects.toThrow('connection lost');
  });

  it('should throw NotFoundError for a user who does not belong to the organization', async () => {
    repository.shareable.findAccessibleById.mockResolvedValue(null);
    repository.findById.mockResolvedValue(mockOrganization);

    // Create a mock user who does not belong to the organization
    const mockUser: Partial<IUserDocument> = {
      id: 'user2',
      isAdmin: false,
    };

    await expect(get(mockUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(NotFoundError);
    expect(repository.shareable.findAccessibleById).toHaveBeenCalledWith(mockUser, 'org1');
    expect(repository.findById).toHaveBeenCalledWith('org1');
  });
});
