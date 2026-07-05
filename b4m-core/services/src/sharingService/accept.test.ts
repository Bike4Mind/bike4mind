import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { InviteType, Permission } from '@bike4mind/common';
import { NotFoundError, ForbiddenError } from '@bike4mind/utils';
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
      organization: { findById: Mock; update: Mock };
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
        organization: { findById: vi.fn(), update: vi.fn() },
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

  it('adds the user to the organization users and userDetails arrays', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        users: expect.arrayContaining([expect.objectContaining({ userId, permissions: [Permission.read] })]),
        userDetails: expect.arrayContaining([expect.objectContaining({ id: userId, email: 'member@example.com' })]),
      })
    );
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
    // selects that org, matching organizationManager.addUserToOrganization.
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
