import { removeManager } from './removeManager';
import { NotFoundError } from '@bike4mind/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('removeManager', () => {
  const mockOrganization = {
    id: 'org-id',
    name: 'Test Organization',
    userId: 'owner-id',
    managerId: 'manager-id',
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
      },
    };
  });

  it('throws NotFoundError if the organization is not found', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(null);
    await expect(removeManager({ organizationId: 'missing-org' }, mockAdapters)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('clears the managerId', async () => {
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);
    mockAdapters.db.organizations.update.mockResolvedValue({ ...mockOrganization, managerId: null });

    const result = await removeManager({ organizationId: 'org-id' }, mockAdapters);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith({ id: 'org-id', managerId: null });
    expect(result).toEqual({ ...mockOrganization, managerId: null });
  });
});
