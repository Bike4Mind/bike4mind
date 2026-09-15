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

  const mockMemberUser = {
    id: 'member-id',
    name: 'Plain Member',
    isAdmin: false,
  } as IUserDocument;

  const mockManagerUser = {
    id: 'manager-id',
    name: 'Manager User',
    isAdmin: false,
  } as IUserDocument;

  // `userId` is the billing owner and is what the roster-administration gate reads; the fixture
  // previously omitted it entirely, which only passed because the old gate was the membership ACL.
  const mockOrganization = {
    id: 'org-id',
    name: 'Test Organization',
    userId: 'owner-id',
    managerId: 'manager-id',
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
          ensureUserDetails: vi.fn(),
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
    mockAdapters.db.organizations.findById.mockResolvedValue(null);

    await expect(
      addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'non-existent-org' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith('user-id');
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('non-existent-org');
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should allow a platform admin to add a member to any organization', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

    const result = await addMember(mockAdminUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('org-id');
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
    mockAdapters.db.organizations.findById.mockResolvedValue(null);

    await expect(
      addMember(mockAdminUser, { userId: 'user-id', organizationId: 'non-existent-org' }, mockAdapters)
    ).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organizations.findById).toHaveBeenCalledWith('non-existent-org');
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  describe('roster-administration authority', () => {
    // The gate used to be the membership ACL (`shareable.findAccessibleById`), which admits any
    // `users[]` row holding `read` - and this function only ever grants `[Permission.read]`, so
    // every ordinary member could enroll arbitrary accounts into the organization.
    it('refuses a plain member of the organization', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(mockUser);
      mockAdapters.db.organizations.findById.mockResolvedValue({
        ...cloneDeep(mockOrganization),
        users: [{ userId: 'member-id', permissions: [Permission.read] }],
      });

      await expect(
        addMember(mockMemberUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters)
      ).rejects.toThrow(NotFoundError);
      expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    });

    it('refuses a stranger to the organization', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(mockUser);
      mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

      await expect(
        addMember({ id: 'nobody' } as IUserDocument, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters)
      ).rejects.toThrow(NotFoundError);
      expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
    });

    it('admits the appointed manager', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(mockUser);
      mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

      await addMember(mockManagerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

      expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
    });
  });

  it('should throw UnprocessableEntityError if organization is at full capacity', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.findById.mockResolvedValue({
      ...mockOrganization,
      seats: 2,
      users: [{ userId: 'user-1' }, { userId: 'user-2' }],
    });
    await expect(
      addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters)
    ).rejects.toThrow(UnprocessableEntityError);
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('should treat members == seats - 1 as full because the owner holds a seat (#1423)', async () => {
    // Owner-inclusive accounting: 2 members + the owner == 3 == seats, so the org is full even though
    // users.length (2) is below seats (3). The member-only definition would have admitted this add.
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.findById.mockResolvedValue({
      ...mockOrganization,
      seats: 3,
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
    mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(orgWithUsers));

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
    mockAdapters.db.organizations.findById.mockResolvedValue(orgWithUser);

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
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result).toEqual({
      organization: {
        ...mockOrganization,
        users: [{ userId: 'user-id', permissions: [Permission.read] }],
      },
      user: mockUser,
    });
    // Targeted write: only users[] is persisted, never the whole document (which would carry a stale
    // userDetails snapshot able to clobber a concurrent credit increment).
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith({
      id: 'org-id',
      users: [{ userId: 'user-id', permissions: [Permission.read] }],
    });
  });

  it("should set the added user's organizationId and persist the user", async () => {
    const freshUser = { id: 'user-id', name: 'Test User', email: 'test@example.com', organizationId: null };
    mockAdapters.db.users.findById.mockResolvedValue(freshUser);
    mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result.user.organizationId).toBe('org-id');
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-id', organizationId: 'org-id' })
    );
  });

  it('should set organizationId even when the user is already a member', async () => {
    const freshUser = { id: 'user-id', name: 'Test User', email: 'test@example.com', organizationId: null };
    mockAdapters.db.users.findById.mockResolvedValue(freshUser);
    mockAdapters.db.organizations.findById.mockResolvedValue({
      ...cloneDeep(mockOrganization),
      users: [{ userId: 'user-id', permissions: [] }],
    });

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    expect(result.user.organizationId).toBe('org-id');
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-id', organizationId: 'org-id' })
    );
  });

  it('should NOT repoint a user who is already working in another organization', async () => {
    // Being added to a second org is not consent to be moved out of the one you are in: repointing
    // would switch the target's active-org billing and team prompt context mid-session.
    const userInAnotherOrg = {
      id: 'user-id',
      name: 'Test User',
      email: 'test@example.com',
      organizationId: 'their-current-org',
    };
    mockAdapters.db.users.findById.mockResolvedValue(userInAnotherOrg);
    mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

    const result = await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

    // Still added to the roster - only the active-org pointer is left alone.
    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
    expect(result.user.organizationId).toBe('their-current-org');
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('should not persist the user when the organization is at full capacity', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(mockUser);
    mockAdapters.db.organizations.findById.mockResolvedValue({
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
    mockAdapters.db.organizations.findById.mockResolvedValue(mockOrganization);

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
      id: 'org-id',
      users: [{ userId: 'user-id', permissions: [Permission.read] }],
    });
  });

  describe('userDetails seeding (#1460)', () => {
    it('seeds the per-member credit row via the atomic ensureUserDetails primitive', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(mockUser);
      mockAdapters.db.organizations.findById.mockResolvedValue(cloneDeep(mockOrganization));

      await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

      // Seeded through the guarded $push, NOT pushed into the whole-doc write - so it can never
      // clobber a concurrent credit increment. Idempotency is the primitive's own guarantee
      // (see OrganizationModel.integration.test.ts), so addMember calls it unconditionally.
      expect(mockAdapters.db.organizations.ensureUserDetails).toHaveBeenCalledWith('org-id', {
        id: 'user-id',
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('never carries userDetails through the whole-doc write', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(mockUser);
      mockAdapters.db.organizations.findById.mockResolvedValue({
        ...cloneDeep(mockOrganization),
        users: [{ userId: 'user-id', permissions: [] }],
        userDetails: [
          { id: 'user-id', email: 'test@example.com', name: 'Test User', usedCredits: 42, lastCreditUsedAt: null },
        ],
      });

      await addMember(mockOwnerUser, { userId: 'user-id', organizationId: 'org-id' }, mockAdapters);

      // The persisted document update is scoped to users[] only; a stale userDetails snapshot
      // (usedCredits: 42 here) is never $set back over a possibly-newer value.
      const updateArg = mockAdapters.db.organizations.update.mock.calls[0][0];
      expect(updateArg).not.toHaveProperty('userDetails');
      expect(mockAdapters.db.organizations.ensureUserDetails).toHaveBeenCalledWith('org-id', {
        id: 'user-id',
        email: 'test@example.com',
        name: 'Test User',
      });
    });
  });
});
