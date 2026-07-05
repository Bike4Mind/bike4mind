import { describe, it, expect, vi, beforeEach } from 'vitest';
import { leave } from './leave';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Permission } from '@bike4mind/common';

describe('organizationService - leave', () => {
  const mockOwnerUser: Partial<IUserDocument> = {
    id: 'owner1',
    name: 'Owner User',
    email: 'owner@example.com',
  };

  const mockMemberUser: Partial<IUserDocument> = {
    id: 'user1',
    name: 'Member User',
    email: 'member@example.com',
  };

  const memberUserShare = {
    userId: 'user1',
    permissions: [Permission.read, Permission.update],
  };

  const secondUserShare = {
    userId: 'user2',
    permissions: [Permission.read],
  };

  const existingOrganization: Partial<IOrganizationDocument> = {
    id: 'org1',
    name: 'Test Organization',
    description: 'Test description',
    userId: 'owner1',
    users: [memberUserShare, secondUserShare],
    userDetails: [
      { id: 'user1', name: 'Member User', email: 'member@example.com', usedCredits: 0, lastCreditUsedAt: null },
      { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
    ],
    seats: 3,
    personal: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  let mockAdapters: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        organizations: {
          shareable: {
            findAccessibleById: vi.fn().mockResolvedValue(existingOrganization),
          },
          update: vi.fn().mockResolvedValue(undefined),
        },
        users: {
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  it('should allow a user to leave an organization', async () => {
    const leaveParams = {
      id: 'org1',
    };

    const result = await leave(mockMemberUser as IUserDocument, leaveParams, mockAdapters);

    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockMemberUser, 'org1');

    const expectedUpdatedOrg = {
      ...existingOrganization,
      users: [secondUserShare],
      userDetails: [
        { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
      ],
    };

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [secondUserShare],
        userDetails: [
          { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
        ],
      })
    );

    expect(result).toEqual(expectedUpdatedOrg);
  });

  it("should clear organizationId when the left org was the user's selected org", async () => {
    const memberWithSelectedOrg = { ...mockMemberUser, organizationId: 'org1' } as IUserDocument;

    await leave(memberWithSelectedOrg, { id: 'org1' }, mockAdapters);

    expect(memberWithSelectedOrg.organizationId).toBeNull();
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user1', organizationId: null })
    );
  });

  it("should NOT touch organizationId when the user's selected org is a different org", async () => {
    const memberWithOtherOrg = { ...mockMemberUser, organizationId: 'other-org' } as IUserDocument;

    await leave(memberWithOtherOrg, { id: 'org1' }, mockAdapters);

    expect(memberWithOtherOrg.organizationId).toBe('other-org');
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('is idempotent under withTransaction retry: a failed user write does not poison the guard', async () => {
    // Simulate the withTransaction retry path: the SAME user object is reused across
    // attempts (leave never re-fetches it). A transient failure on the first user
    // write must NOT leave the in-memory guard field mutated, or the retry would skip
    // the write and leave a stale organizationId.
    const user = { ...mockMemberUser, organizationId: 'org1' } as IUserDocument;
    // fresh org copy per attempt so the callback re-runs cleanly
    mockAdapters.db.organizations.shareable.findAccessibleById.mockImplementation(async () => ({
      ...existingOrganization,
      users: [memberUserShare, secondUserShare],
      userDetails: existingOrganization.userDetails?.map(d => ({ ...d })),
    }));
    mockAdapters.db.users.update
      .mockRejectedValueOnce(new Error('TransientTransactionError: WriteConflict'))
      .mockResolvedValueOnce(undefined);

    // Attempt 1 throws on the user write - memory must be untouched.
    await expect(leave(user, { id: 'org1' }, mockAdapters)).rejects.toThrow('WriteConflict');
    expect(user.organizationId).toBe('org1');

    // Attempt 2 (retry): guard is still true, so the write re-runs and succeeds.
    await leave(user, { id: 'org1' }, mockAdapters);
    expect(user.organizationId).toBeNull();
    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(2);
    expect(mockAdapters.db.users.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'user1', organizationId: null })
    );
  });

  it('should throw NotFoundError when organization is not found', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);

    await expect(leave(mockMemberUser as IUserDocument, { id: 'nonexistent-org' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should throw BadRequestError when user tries to leave their own organization', async () => {
    await expect(leave(mockOwnerUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(BadRequestError);

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should throw NotFoundError when user is not in the organization', async () => {
    const notMemberUser: Partial<IUserDocument> = {
      id: 'not-member',
      name: 'Not Member User',
      email: 'notmember@example.com',
    };

    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);

    const leaveParams = {
      id: 'org1',
    };

    // Call the function and expect it to throw
    await expect(leave(notMemberUser as IUserDocument, leaveParams, mockAdapters)).rejects.toThrow(NotFoundError);

    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should validate and secure parameters', async () => {
    const leaveParams = {
      id: 'org1',
      // @ts-ignore - Adding extra parameters to test parameter validation
      extraParam: 'should be ignored',
    };

    await leave(mockMemberUser as IUserDocument, leaveParams, mockAdapters);

    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockMemberUser, 'org1');

    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });

  it('should initialize userDetails as empty array if it is null', async () => {
    const orgWithoutUserDetails = {
      ...existingOrganization,
      userDetails: null,
    };

    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(orgWithoutUserDetails);

    const leaveParams = {
      id: 'org1',
    };

    await leave(mockMemberUser as IUserDocument, leaveParams, mockAdapters);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        userDetails: [],
        users: [secondUserShare],
      })
    );
  });
});
