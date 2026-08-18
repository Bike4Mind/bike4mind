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

  // Fresh copy per call so mutating `organization` (users/userDetails/adminUserIds) in one test
  // never bleeds into the next.
  const freshOrg = (over: Partial<IOrganizationDocument> = {}): Partial<IOrganizationDocument> => ({
    id: 'org1',
    name: 'Test Organization',
    description: 'Test description',
    userId: 'owner1',
    users: [{ ...memberUserShare }, { ...secondUserShare }],
    userDetails: [
      { id: 'user1', name: 'Member User', email: 'member@example.com', usedCredits: 0, lastCreditUsedAt: null },
      { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
    ],
    seats: 3,
    personal: false,
    ...over,
  });

  let mockAdapters: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        organizations: {
          shareable: {
            findAccessibleById: vi.fn().mockResolvedValue(freshOrg()),
          },
          update: vi.fn().mockResolvedValue(undefined),
        },
        users: {
          update: vi.fn().mockResolvedValue(undefined),
          removeGroupsFromUser: vi.fn().mockResolvedValue(undefined),
        },
        // No org groups by default, so the group purge is a no-op unless a test sets some.
        groups: {
          findByOrganization: vi.fn().mockResolvedValue([]),
        },
      },
    };
  });

  it('removes the user from the org users and userDetails', async () => {
    const result = await leave(mockMemberUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockMemberUser, 'org1');
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [secondUserShare],
        userDetails: [
          { id: 'user2', name: 'Second User', email: 'second@example.com', usedCredits: 0, lastCreditUsedAt: null },
        ],
      })
    );
    expect(result.users).toEqual([secondUserShare]);
  });

  it("clears organizationId when the left org was the user's selected org", async () => {
    const memberWithSelectedOrg = { ...mockMemberUser, organizationId: 'org1' } as IUserDocument;

    await leave(memberWithSelectedOrg, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user1', organizationId: null })
    );
    // leave must NOT mutate the caller-supplied user (retry-safety, see below).
    expect(memberWithSelectedOrg.organizationId).toBe('org1');
  });

  it("does NOT clear organizationId when the user's selected org is a different org", async () => {
    const memberWithOtherOrg = { ...mockMemberUser, organizationId: 'other-org' } as IUserDocument;

    await leave(memberWithOtherOrg, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    expect(memberWithOtherOrg.organizationId).toBe('other-org');
  });

  it('re-issues the org-clear write on a withTransaction retry (no in-memory poisoning)', async () => {
    // withTransaction re-runs the callback against the SAME `user` object on a transient error
    // (leave never re-fetches it). Because leave no longer mutates the user, the guard stays true
    // and the idempotent set-to-null is issued on EVERY attempt. The old code mutated
    // user.organizationId after attempt 1, which flipped the guard false on a commit-time retry
    // and silently skipped the write - leaving a stale organizationId.
    const user = { ...mockMemberUser, organizationId: 'org1', groups: ['g-org1', 'keep'] } as IUserDocument;
    mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'g-org1' }]);

    await leave(user, { id: 'org1' }, mockAdapters); // attempt 1
    await leave(user, { id: 'org1' }, mockAdapters); // retry

    const orgClearCalls = mockAdapters.db.users.update.mock.calls.filter(([p]: any) => p.organizationId === null);
    expect(orgClearCalls).toHaveLength(2);
    expect(mockAdapters.db.users.removeGroupsFromUser).toHaveBeenCalledWith('user1', ['g-org1']);
    expect(user.organizationId).toBe('org1');
  });

  it('purges the left org group ids from the departing user (via removeGroupsFromUser)', async () => {
    const member = {
      ...mockMemberUser,
      organizationId: 'org1',
      groups: ['g-org1-a', 'g-org1-b', 'g-other'],
    } as IUserDocument;
    mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'g-org1-a' }, { id: 'g-org1-b' }]);

    await leave(member, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1');
    expect(mockAdapters.db.users.removeGroupsFromUser).toHaveBeenCalledWith('user1', ['g-org1-a', 'g-org1-b']);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user1', organizationId: null })
    );
  });

  it("purges org groups even when the left org is not the user's selected org", async () => {
    const member = { ...mockMemberUser, organizationId: 'other-org', groups: ['g-org1-a', 'keep'] } as IUserDocument;
    mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'g-org1-a' }]);

    await leave(member, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.users.removeGroupsFromUser).toHaveBeenCalledWith('user1', ['g-org1-a']);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled(); // selected org untouched
    expect(member.organizationId).toBe('other-org');
  });

  it('drops the departing user from the org adminUserIds', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(
      freshOrg({ adminUserIds: ['user1', 'other-admin'] })
    );

    const result = await leave(mockMemberUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(result.adminUserIds).toEqual(['other-admin']);
    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserIds: ['other-admin'] })
    );
  });

  it('throws NotFoundError when organization is not found', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(null);

    await expect(leave(mockMemberUser as IUserDocument, { id: 'nonexistent-org' }, mockAdapters)).rejects.toThrow(
      NotFoundError
    );
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('throws BadRequestError when a user tries to leave their own organization', async () => {
    await expect(leave(mockOwnerUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(BadRequestError);
    expect(mockAdapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('validates and secures parameters', async () => {
    const leaveParams = {
      id: 'org1',
      // @ts-ignore - extra parameter to prove it is stripped by secureParameters
      extraParam: 'should be ignored',
    };

    await leave(mockMemberUser as IUserDocument, leaveParams, mockAdapters);

    expect(mockAdapters.db.organizations.shareable.findAccessibleById).toHaveBeenCalledWith(mockMemberUser, 'org1');
    expect(mockAdapters.db.organizations.update).toHaveBeenCalled();
  });

  it('initializes userDetails as an empty array when it is null', async () => {
    mockAdapters.db.organizations.shareable.findAccessibleById.mockResolvedValue(freshOrg({ userDetails: null }));

    await leave(mockMemberUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(mockAdapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ userDetails: [], users: [secondUserShare] })
    );
  });
});
