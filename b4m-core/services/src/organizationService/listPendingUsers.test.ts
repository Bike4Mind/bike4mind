import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import type { IUserDocument } from '@bike4mind/common';
import { listPendingUsers } from './listPendingUsers';

describe('listPendingUsers', () => {
  const organizations = {
    findById: vi.fn(),
    shareable: { findAccessibleById: vi.fn() },
  };
  const invites = { findAllByDocumentId: vi.fn() };
  const users = { findAllByEmailsOrUsernames: vi.fn() };
  const adapters = { db: { organizations, invites, users } } as unknown as Parameters<typeof listPendingUsers>[2];
  const organization = { id: 'org1', userId: 'owner1', managerId: 'manager1', users: [] };

  beforeEach(() => {
    organizations.findById.mockReset().mockResolvedValue(organization);
    organizations.shareable.findAccessibleById.mockReset().mockResolvedValue(null);
    invites.findAllByDocumentId.mockReset().mockResolvedValue([]);
    users.findAllByEmailsOrUsernames.mockReset().mockResolvedValue([]);
  });

  it('lets an appointed manager read the pending roster without a membership row', async () => {
    const manager = { id: 'manager1', isAdmin: false } as IUserDocument;

    await expect(listPendingUsers(manager, { organizationId: 'org1' }, adapters)).resolves.toEqual([]);
    expect(invites.findAllByDocumentId).toHaveBeenCalledWith('org1');
  });

  it('keeps the pending roster hidden from an unrelated user', async () => {
    const stranger = { id: 'stranger', isAdmin: false } as IUserDocument;

    await expect(listPendingUsers(stranger, { organizationId: 'org1' }, adapters)).rejects.toThrow(NotFoundError);
    expect(invites.findAllByDocumentId).not.toHaveBeenCalled();
  });
});
