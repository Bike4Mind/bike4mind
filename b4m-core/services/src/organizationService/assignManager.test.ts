import { assignManager } from './assignManager';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('assignManager', () => {
  const mockOrganization = {
    id: 'org-id',
    name: 'Test Organization',
    userId: 'owner-id',
  };

  let mockAdapters: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        organizations: {
          findById: vi.fn(),
          update: vi.fn(),
        },
        users: {
          findById: vi.fn(),
        },
      },
    };
  });

  it('throws NotFoundError if the organization is not found', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(null);
    await expect(
      assignManager({ organizationId: 'missing-org', managerId: 'manager-id' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('throws BadRequestError if the manager is the billing owner', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);
    await expect(assignManager({ organizationId: 'org-id', managerId: 'owner-id' }, mockAdapters)).rejects.toThrow(
      BadRequestError
    );
    expect(mockAdapters.db.users.findById).not.toHaveBeenCalled();
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError if the manager user does not exist', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(assignManager({ organizationId: 'org-id', managerId: 'ghost-id' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('assigns the manager and persists managerId', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);
    mockAdapters.db.users.findById.mockResolvedValue({ id: 'manager-id' });
    mockAdapters.db.organizations.update.mockResolvedValue({ ...mockOrganization, managerId: 'manager-id' });

    const result = await assignManager({ organizationId: 'org-id', managerId: 'manager-id' }, mockAdapters);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith({ id: 'org-id', managerId: 'manager-id' });
    expect(result).toEqual({ ...mockOrganization, managerId: 'manager-id' });
  });
});
