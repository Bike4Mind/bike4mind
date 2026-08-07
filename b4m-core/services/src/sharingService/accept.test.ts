import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { InviteType, Permission } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { acceptInvite } from './accept';

describe('sharingService - acceptInvite (Organization)', () => {
  const userId = 'user-123';
  const organizationId = 'org-456';
  const inviteId = 'invite-789';

  let mockAdapters: {
    db: {
      invites: { findById: Mock; update: Mock };
      sessions: { findById: Mock; update: Mock; findAllByIds: Mock };
      projects: { findById: Mock; update: Mock };
      fabFiles: { findById: Mock; update: Mock; findAllByIds: Mock };
      groups: { findById: Mock };
      organization: { findById: Mock; update: Mock; ensureUserDetails: Mock };
      users: { findById: Mock; update: Mock };
    };
  };

  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    id: userId,
    email: 'member@example.com',
    username: 'member',
    name: 'Member',
    organizationId: null,
    ...overrides,
  });

  const makeInvite = () => ({
    id: inviteId,
    type: InviteType.Organization,
    documentId: organizationId,
    permissions: [Permission.read],
    remaining: 5,
    accepted: 0,
    recipients: { pending: ['member@example.com'], refused: [], accepted: [] },
  });

  const makeOrganization = (overrides: Record<string, unknown> = {}) => ({
    id: organizationId,
    users: [],
    userDetails: [],
    seats: 10,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        invites: { findById: vi.fn(), update: vi.fn() },
        sessions: { findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        projects: { findById: vi.fn(), update: vi.fn() },
        fabFiles: { findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        groups: { findById: vi.fn() },
        organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
        users: { findById: vi.fn(), update: vi.fn() },
      },
    };
  });

  it("sets the accepting user's organizationId and persists the user", async () => {
    const user = makeUser();
    mockAdapters.db.users.findById.mockResolvedValue(user);
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ id: userId, organizationId }));
  });

  it('adds the user to the organization users[] via a targeted write and seeds the credit row atomically', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    // users[] persisted through a targeted write - never the whole document (which would $set a
    // stale userDetails snapshot able to clobber a concurrent credit increment).
    const updateArg = mockAdapters.db.organization.update.mock.calls[0][0];
    expect(updateArg).toEqual({
      id: organizationId,
      users: expect.arrayContaining([expect.objectContaining({ userId, permissions: [Permission.read] })]),
    });
    expect(updateArg).not.toHaveProperty('userDetails');

    // Credit side-table seeded through the idempotent guarded $push, not an unconditional push.
    expect(mockAdapters.db.organization.ensureUserDetails).toHaveBeenCalledWith(organizationId, {
      id: userId,
      email: 'member@example.com',
      name: 'Member',
    });
  });

  it('seeds the credit row via ensureUserDetails so a re-accept cannot create a duplicate row', async () => {
    // The old path did `userDetails.push(...)` unconditionally, so re-accepting an invite for an org
    // the member already had a row in produced a second phantom row. Routing through the guarded
    // primitive is what makes the seed idempotent - mirrors the Group double-accept guard below.
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(
      makeOrganization({
        userDetails: [{ id: userId, email: 'member@example.com', name: 'Member', usedCredits: 7 }],
      })
    );

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.organization.ensureUserDetails).toHaveBeenCalledWith(organizationId, {
      id: userId,
      email: 'member@example.com',
      name: 'Member',
    });
    // No raw push into the persisted document.
    expect(mockAdapters.db.organization.update.mock.calls[0][0]).not.toHaveProperty('userDetails');
  });

  it('updates the organization before persisting the user (membership is fully provisioned)', async () => {
    const callOrder: string[] = [];
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());
    mockAdapters.db.organization.update.mockImplementation(async () => {
      callOrder.push('organization.update');
    });
    mockAdapters.db.users.update.mockImplementation(async () => {
      callOrder.push('users.update');
    });

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(callOrder).toEqual(['organization.update', 'users.update']);
  });

  it('overwrites a previously selected organizationId with the newly accepted one', async () => {
    // organizationId is the *currently selected* org; accepting a new invite
    // selects that org, matching organizationService.addMember.
    const user = makeUser({ organizationId: 'previous-org' });
    mockAdapters.db.users.findById.mockResolvedValue(user);
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
  });

  it('throws when the organization is full and does not update the user', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    // seats reached: existing users + owner (+1) >= seats
    mockAdapters.db.organization.findById.mockResolvedValue(
      makeOrganization({ users: [{ userId: 'a' }, { userId: 'b' }], seats: 3 })
    );

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(ForbiddenError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the organization does not exist', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });
});

describe('sharingService - acceptInvite (Group)', () => {
  // Regression coverage for #1224: the Group case previously wrote user.groups with no org
  // membership check at all. These pin the write-path invariant (2) it now enforces - the
  // accepting user must already be a member of the group's owning organization - mirroring
  // organizationService/groupMembership.ts's assertion of the same rule on every other
  // group-membership write.
  const userId = 'user-123';
  const groupId = 'group-456';
  const organizationId = 'org-789';
  const inviteId = 'invite-999';

  let mockAdapters: {
    db: {
      invites: { findById: Mock; update: Mock };
      sessions: { findById: Mock; update: Mock; findAllByIds: Mock };
      projects: { findById: Mock; update: Mock };
      fabFiles: { findById: Mock; update: Mock; findAllByIds: Mock };
      groups: { findById: Mock };
      organization: { findById: Mock; update: Mock };
      users: { findById: Mock; update: Mock };
    };
  };

  const makeUser = (overrides: Record<string, unknown> = {}) => ({
    id: userId,
    email: 'member@example.com',
    username: 'member',
    name: 'Member',
    groups: [] as string[],
    ...overrides,
  });

  const makeInvite = () => ({
    id: inviteId,
    type: InviteType.Group,
    documentId: groupId,
    permissions: [Permission.read],
    remaining: 1,
    accepted: 0,
    recipients: { pending: ['member@example.com'], refused: [], accepted: [] },
  });

  const makeGroup = (overrides: Record<string, unknown> = {}) => ({
    id: groupId,
    name: 'Sales',
    type: 'sales',
    organizationId,
    ...overrides,
  });

  const makeOrganization = (overrides: Record<string, unknown> = {}) => ({
    id: organizationId,
    users: [{ userId, permissions: [Permission.read] }],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        invites: { findById: vi.fn(), update: vi.fn() },
        sessions: { findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        projects: { findById: vi.fn(), update: vi.fn() },
        fabFiles: { findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        groups: { findById: vi.fn() },
        organization: { findById: vi.fn(), update: vi.fn() },
        users: { findById: vi.fn(), update: vi.fn() },
      },
    };
  });

  it('adds the group id to user.groups for a member of the owning organization', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.groups.findById.mockResolvedValue(makeGroup());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ groups: [groupId] }));
  });

  it('rejects a caller who is not a member of the group organization, and does not write', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.groups.findById.mockResolvedValue(makeGroup());
    // The accepting user is not in organization.users - an outsider holding the invite id.
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization({ users: [{ userId: 'someone-else' }] }));

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(BadRequestError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the group does not exist (or is soft-deleted)', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.groups.findById.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.organization.findById).not.toHaveBeenCalled();
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the group's organization does not exist", async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.groups.findById.mockResolvedValue(makeGroup());
    mockAdapters.db.organization.findById.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });

  it('does not duplicate the group id if the user already holds it (double-accept)', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser({ groups: [groupId] }));
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.groups.findById.mockResolvedValue(makeGroup());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(expect.objectContaining({ groups: [groupId] }));
  });
});
