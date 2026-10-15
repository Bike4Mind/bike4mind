import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { InviteType, Permission } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { acceptInvite } from './accept';

describe('sharingService - acceptInvite (Organization)', () => {
  const userId = 'user-123';
  const organizationId = 'org-456';
  const inviteId = '65a1f77bcf86cd7994390789';

  let mockAdapters: {
    db: {
      invites: { findById: Mock; findByToken: Mock; update: Mock };
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
        invites: { findById: vi.fn(), findByToken: vi.fn(async () => null), update: vi.fn() },
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

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, organizationId });
    expect(mockAdapters.db.users.update.mock.calls[0][1]).toBeUndefined();
    expect(mockAdapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['member@example.com'] },
      accepted: 1,
      remaining: 4,
    });
  });

  it('adds the user to the organization users[] via a targeted write and seeds the credit row atomically', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(makeUser());
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    // users[] persisted through a targeted write - never the whole document (which would $set a
    // stale userDetails snapshot able to clobber a concurrent credit increment).
    const updateArg = mockAdapters.db.organization.update.mock.calls[0][0];
    expect(updateArg).toStrictEqual({
      id: organizationId,
      users: [{ userId, permissions: [Permission.read], projectId: undefined, sessionId: undefined }],
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

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, organizationId });
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
  const inviteId = '65a1f77bcf86cd7994390999';

  let mockAdapters: {
    db: {
      invites: { findById: Mock; findByToken: Mock; update: Mock };
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
        invites: { findById: vi.fn(), findByToken: vi.fn(async () => null), update: vi.fn() },
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

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, groups: [groupId] });
    expect(mockAdapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['member@example.com'] },
      accepted: 1,
      remaining: 0,
    });
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

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, groups: [groupId] });
  });
});

/**
 * `remaining` on a By-Users FabFile invite now scales to the number of named recipients
 * (#1151), not a flat 1 - a human reviewer caught that acceptInvite never checked the
 * accepter was actually one of the recipients named in `pending`, so an unintended
 * accepter could claim a slot meant for someone else while a named recipient still
 * hadn't accepted. Link-only invites (empty `pending` from creation) must stay open to
 * anyone; a fully-consumed named invite is already blocked by the `remaining <= 0` check
 * regardless of identity, so this only needs to gate the "still has named recipients left" case.
 */
describe('sharingService - acceptInvite (FabFile recipient membership)', () => {
  const userId = 'user-1';
  const fileId = 'file-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  const makeUser = (email: string) => ({ id: userId, email, username: 'u' });

  const makeInvite = (pending: string[], remaining: number) => ({
    id: inviteId,
    type: InviteType.FabFile,
    documentId: fileId,
    permissions: [Permission.read, Permission.share],
    remaining,
    accepted: 0,
    recipients: { pending, refused: [], accepted: [] },
  });

  const makeAdapters = () => ({
    db: {
      invites: { findById: vi.fn(), findByToken: vi.fn(async () => null), update: vi.fn() },
      fabFiles: { findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { findById: vi.fn(), update: vi.fn() },
      projects: { findById: vi.fn(), update: vi.fn() },
      groups: { findById: vi.fn() },
      organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
      users: { findById: vi.fn(), update: vi.fn() },
    },
  });

  // The gate used to short-circuit on `pending.length === 0`, which is precisely the state a
  // Project or Organization invite was always in: its recipients are raw user ids that
  // createInvite could not resolve. Any authenticated caller holding the invite id could accept
  // and join, picking up grants on every file and session the project contains.
  it('rejects a stranger accepting a named Project invite whose recipients did not resolve', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('stranger@x.com'));
    adapters.db.invites.findById.mockResolvedValue({
      ...makeInvite([], 1),
      type: InviteType.Project,
      isLinkOnly: false,
    });

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.invites.update).not.toHaveBeenCalled();
  });

  it('fails closed on a legacy named invite minted before the link-only flag existed', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('stranger@x.com'));
    adapters.db.invites.findById.mockResolvedValue({ ...makeInvite([], 1), type: InviteType.Project });

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).rejects.toThrow(ForbiddenError);
  });

  it('still lets anyone redeem a genuine link invite', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('anyone@x.com'));
    adapters.db.invites.findById.mockResolvedValue({ ...makeInvite([], 5), isLinkOnly: true });

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).resolves.toBeDefined();
  });

  it('rejects an accepter who is not among the still-pending named recipients', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('uninvited@x.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite(['a@x.com', 'b@x.com'], 2));

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.invites.update).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('admits a recipient whose stored email differs only in case from the pending address', async () => {
    // A Project invite to an address with no account stores it lowercased; an SSO signup keeps the
    // provider's casing.
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('New.Person@Example.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite(['new.person@example.com', 'b@x.com'], 2));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.update.mock.calls[0][0]).toMatchObject({
      recipients: { pending: ['b@x.com'], refused: [], accepted: ['New.Person@Example.com'] },
      remaining: 1,
    });
  });

  it('allows an accepter who is one of the named pending recipients', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('a@x.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite(['a@x.com', 'b@x.com'], 2));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: ['b@x.com'], refused: [], accepted: ['a@x.com'] },
      accepted: 1,
      remaining: 1,
    });
    expect(adapters.db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.update.mock.calls[0][0]).toStrictEqual({
      id: fileId,
      users: [{ userId, permissions: [Permission.read, Permission.share], projectId: undefined, sessionId: undefined }],
    });
  });

  it('allows anyone to accept a link-only invite (pending was never populated)', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('anyone@x.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite([], 1000));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['anyone@x.com'] },
      accepted: 1,
      remaining: 999,
    });
  });

  it('reports "already accepted" for a re-accept, not "not sent to your account", when other recipients are still pending', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('a@x.com'));
    // a@x.com already accepted and moved out of pending; b@x.com is still pending.
    adapters.db.invites.findById.mockResolvedValue({
      ...makeInvite(['b@x.com'], 1),
      recipients: { pending: ['b@x.com'], refused: [], accepted: ['a@x.com'] },
    });

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).rejects.toThrow(
      'User has already accepted the invite'
    );
    expect(adapters.db.invites.update).not.toHaveBeenCalled();
  });
});

/**
 * The Invite schema's `expiresAt` was never checked on redemption, so an expired share
 * link or email invite stayed redeemable forever. createInvite defaults expiresAt 100
 * years out, so a normal invite is never affected by this check.
 */
describe('sharingService - acceptInvite (expiry)', () => {
  const userId = 'user-1';
  const fileId = 'file-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  const makeUser = () => ({ id: userId, email: 'a@x.com', username: 'a' });

  const makeInvite = (expiresAt: Date | undefined) => ({
    id: inviteId,
    type: InviteType.FabFile,
    documentId: fileId,
    permissions: [Permission.read],
    remaining: 1,
    accepted: 0,
    expiresAt,
    recipients: { pending: [], refused: [], accepted: [] },
  });

  const makeAdapters = () => ({
    db: {
      invites: { findById: vi.fn(), findByToken: vi.fn(async () => null), update: vi.fn() },
      fabFiles: { findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { findById: vi.fn(), update: vi.fn() },
      projects: { findById: vi.fn(), update: vi.fn() },
      groups: { findById: vi.fn() },
      organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
      users: { findById: vi.fn(), update: vi.fn() },
    },
  });

  it('rejects redemption of an invite whose expiresAt has passed', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser());
    adapters.db.invites.findById.mockResolvedValue(makeInvite(new Date(Date.now() - 1000)));

    await expect(acceptInvite(userId, { id: inviteId }, adapters as any)).rejects.toThrow('Invite has expired');
    expect(adapters.db.invites.update).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('allows redemption of an invite whose expiresAt is in the future', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser());
    adapters.db.invites.findById.mockResolvedValue(makeInvite(new Date(Date.now() + 1000 * 60 * 60)));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['a@x.com'] },
      accepted: 1,
      remaining: 0,
    });
  });

  it('allows redemption of an invite with no expiresAt set', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser());
    adapters.db.invites.findById.mockResolvedValue(makeInvite(undefined));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['a@x.com'] },
      accepted: 1,
      remaining: 0,
    });
  });
});

/**
 * A session's knowledgeIds can name files the inviter neither owns nor holds share on
 * (e.g. attached from someone else's shared session). Accepting a Session invite must
 * not launder access to those files through the invite - the propagated grant on each
 * attached file is capped at what the INVITER actually holds on it.
 */
describe('sharingService - acceptInvite (Session knowledgeId propagation)', () => {
  const userId = 'user-1';
  const inviterId = 'inviter-1';
  const sessionId = 'session-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  const makeUser = () => ({ id: userId, email: 'accepter@x.com', username: 'accepter' });

  const makeInvite = (overrides: Record<string, unknown> = {}) => ({
    id: inviteId,
    type: InviteType.Session,
    documentId: sessionId,
    permissions: [Permission.read, Permission.update, Permission.share],
    remaining: 1,
    accepted: 0,
    inviterId,
    recipients: { pending: [], refused: [], accepted: [] },
    ...overrides,
  });

  const makeSession = (knowledgeIds: string[], sessionOwnerId = inviterId) => ({
    id: sessionId,
    userId: sessionOwnerId,
    knowledgeIds,
  });

  const makeAdapters = () => ({
    db: {
      invites: { findById: vi.fn(), findByToken: vi.fn(async () => null), update: vi.fn() },
      fabFiles: { findById: vi.fn(), update: vi.fn() },
      sessions: { findById: vi.fn(), update: vi.fn() },
      projects: { findById: vi.fn(), update: vi.fn() },
      groups: { findById: vi.fn() },
      organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
      users: { findById: vi.fn(), update: vi.fn() },
    },
  });

  it('skips a file the inviter has no share on, without failing the accept', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById.mockResolvedValue(makeInvite());
    adapters.db.sessions.findById.mockResolvedValue(makeSession(['file-untouchable']));
    // The inviter is looked up separately from the accepter (findById is used for both).
    adapters.db.users.findById.mockImplementation(async (id: string) =>
      id === inviterId ? { id: inviterId, groups: [] } : makeUser()
    );
    adapters.db.fabFiles.findById.mockResolvedValue({
      id: 'file-untouchable',
      userId: 'someone-else',
      users: [],
      groups: [],
    });

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
    // The session share itself still goes through - only the file grant is skipped.
    expect(adapters.db.sessions.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.sessions.update.mock.calls[0][0]).toStrictEqual({
      id: sessionId,
      users: [
        {
          userId,
          permissions: [Permission.read, Permission.update, Permission.share],
          projectId: undefined,
          sessionId: undefined,
        },
      ],
    });
    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['accepter@x.com'] },
      accepted: 1,
      remaining: 0,
    });
  });

  it('propagates nothing when the inviter cannot share the file, even if they can read it', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById.mockResolvedValue(makeInvite());
    adapters.db.sessions.findById.mockResolvedValue(makeSession(['file-shared']));
    adapters.db.users.findById.mockImplementation(async (id: string) =>
      id === inviterId ? { id: inviterId, groups: [] } : { id: userId, email: 'accepter@x.com', username: 'accepter' }
    );
    // Inviter holds only `read` on this file. Passing that read on is still a re-share of a file
    // they were never given authority to share, so nothing propagates.
    adapters.db.fabFiles.findById.mockResolvedValue({
      id: 'file-shared',
      userId: 'owner',
      users: [{ userId: inviterId, permissions: [Permission.read] }],
      groups: [],
    });

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it("caps the propagated grant at the inviter's held permissions once the share gate passes", async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById.mockResolvedValue(makeInvite());
    adapters.db.sessions.findById.mockResolvedValue(makeSession(['file-shared']));
    adapters.db.users.findById.mockImplementation(async (id: string) =>
      id === inviterId ? { id: inviterId, groups: [] } : { id: userId, email: 'accepter@x.com', username: 'accepter' }
    );
    // Inviter holds read and share, so the gate opens, but not update - the invite's face-value
    // permissions (read/update/share) must still be trimmed to what they actually hold.
    adapters.db.fabFiles.findById.mockResolvedValue({
      id: 'file-shared',
      userId: 'owner',
      users: [{ userId: inviterId, permissions: [Permission.read, Permission.share] }],
      groups: [],
    });

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    const written = adapters.db.fabFiles.update.mock.calls[0][0];
    const entry = written.users.find((u: { userId: string }) => u.userId === userId);
    expect(entry.permissions).toEqual([Permission.read, Permission.share]);
  });

  it('propagates the invite permissions when the inviter owns the file', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById.mockResolvedValue(makeInvite());
    adapters.db.sessions.findById.mockResolvedValue(makeSession(['file-owned']));
    adapters.db.users.findById.mockImplementation(async (id: string) =>
      id === inviterId ? { id: inviterId, groups: [] } : { id: userId, email: 'accepter@x.com', username: 'accepter' }
    );
    adapters.db.fabFiles.findById.mockResolvedValue({ id: 'file-owned', userId: inviterId, users: [], groups: [] });

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.fabFiles.update).toHaveBeenCalledTimes(1);
    // sessionId is the provenance tag, asserted here because this is its only write site: without
    // it the row is untagged, merges with a direct share, and both cascades delete the pair.
    expect(adapters.db.fabFiles.update.mock.calls[0][0]).toStrictEqual({
      id: 'file-owned',
      users: [
        {
          userId,
          permissions: [Permission.read, Permission.update, Permission.share],
          projectId: undefined,
          sessionId,
        },
      ],
    });
  });

  it('falls back to the session-owner-only rule for a legacy invite with no inviterId', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById.mockResolvedValue(makeInvite({ inviterId: undefined }));
    // Session owned by the inviter; one attached file it owns, one it does not.
    adapters.db.sessions.findById.mockResolvedValue(makeSession(['file-owned', 'file-foreign'], inviterId));
    adapters.db.users.findById.mockResolvedValue({ id: userId, email: 'accepter@x.com', username: 'accepter' });
    adapters.db.fabFiles.findById.mockImplementation(async (id: string) =>
      id === 'file-owned'
        ? { id: 'file-owned', userId: inviterId, users: [], groups: [] }
        : { id: 'file-foreign', userId: 'someone-else', users: [], groups: [] }
    );

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.update.mock.calls[0][0]).toStrictEqual({
      id: 'file-owned',
      users: [
        {
          userId,
          permissions: [Permission.read, Permission.update, Permission.share],
          projectId: undefined,
          sessionId,
        },
      ],
    });
  });
});

/**
 * Accept is reached from two surfaces holding different keys. The inbox lists invites through
 * `findAllByPendingUserIdOrEmail`, whose projection carries no token, so it can only address them by
 * `_id`; the share page passes whatever the URL carries, which since the token cutover is the token.
 * Closing the id door for every tokenized invite would 404 every inbox accept.
 */
describe('sharingService - acceptInvite (addressing)', () => {
  const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';
  const ID = '65a1f77bcf86cd7994390001';
  const fileId = 'file-1';

  const tokenizedNamedInvite = () => ({
    id: ID,
    token: TOKEN,
    type: InviteType.FabFile,
    documentId: fileId,
    isLinkOnly: false,
    permissions: [Permission.read],
    remaining: 1,
    accepted: 0,
    recipients: { pending: ['me@example.com'], refused: [], accepted: [] },
  });

  const makeAdapters = () => ({
    db: {
      invites: { findById: vi.fn(async () => null), findByToken: vi.fn(async () => null), update: vi.fn() },
      fabFiles: { findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { findById: vi.fn(), update: vi.fn() },
      projects: { findById: vi.fn(), update: vi.fn() },
      groups: { findById: vi.fn() },
      organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
      users: {
        findById: vi.fn(async () => ({ id: 'user-1', email: 'me@example.com', username: 'u' })),
        update: vi.fn(),
      },
    },
  });

  it('accepts a tokenized named invite by token, as the emailed link addresses it', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findByToken = vi.fn(async () => tokenizedNamedInvite()) as never;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await acceptInvite('user-1', { id: TOKEN }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: ID,
      recipients: { pending: [], refused: [], accepted: ['me@example.com'] },
      accepted: 1,
      remaining: 0,
    });
  });

  it('accepts that same invite by id, as the inbox addresses it', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById = vi.fn(async () => tokenizedNamedInvite()) as never;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await acceptInvite('user-1', { id: ID }, adapters as any);

    expect(adapters.db.invites.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: ID,
      recipients: { pending: [], refused: [], accepted: ['me@example.com'] },
      accepted: 1,
      remaining: 0,
    });
  });

  // The finding stays closed where it applies: a link invite names nobody, so the key is the whole
  // authorization and its id must not resolve.
  it('still refuses a tokenized LINK invite addressed by its id', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById = vi.fn(async () => ({
      ...tokenizedNamedInvite(),
      isLinkOnly: true,
      recipients: { pending: [], refused: [], accepted: [] },
    })) as never;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(acceptInvite('user-1', { id: ID }, adapters as any)).rejects.toThrow(/invite not found/i);
    expect(adapters.db.invites.update).not.toHaveBeenCalled();
  });
});

describe('sharingService - acceptInvite (Project)', () => {
  const userId = 'user-1';
  const projectId = 'project-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  it('writes the invite, project, and each attached file and session as targeted partials', async () => {
    const db = {
      invites: {
        findById: vi.fn(async () => ({
          id: inviteId,
          type: InviteType.Project,
          documentId: projectId,
          isLinkOnly: true,
          permissions: [Permission.read],
          remaining: 3,
          accepted: 0,
          recipients: { pending: [], refused: [], accepted: [] },
        })),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
      },
      projects: {
        findById: vi.fn(async () => ({
          id: projectId,
          users: [],
          fileIds: ['file-1'],
          systemPrompts: [{ fileId: 'prompt-1' }],
          sessionIds: ['session-1'],
        })),
        update: vi.fn(),
      },
      fabFiles: {
        findAllByIds: vi.fn(async () => [
          { id: 'file-1', users: [] },
          { id: 'prompt-1', users: [] },
        ]),
        update: vi.fn(),
      },
      sessions: { findAllByIds: vi.fn(async () => [{ id: 'session-1', users: [] }]), update: vi.fn() },
      users: { findById: vi.fn(async () => ({ id: userId, email: 'a@x.com', username: 'a' })), update: vi.fn() },
    };

    await acceptInvite(userId, { id: inviteId }, { db } as never);

    const grant = [{ userId, permissions: [Permission.read], projectId, sessionId: undefined }];
    expect(db.invites.update).toHaveBeenCalledTimes(1);
    expect(db.invites.update.mock.calls[0][0]).toStrictEqual({
      id: inviteId,
      recipients: { pending: [], refused: [], accepted: ['a@x.com'] },
      accepted: 1,
      remaining: 2,
    });
    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: projectId,
      users: [{ userId, permissions: [Permission.read], projectId: undefined, sessionId: undefined }],
    });
    expect(db.fabFiles.update).toHaveBeenCalledTimes(2);
    expect(db.fabFiles.update.mock.calls[0][0]).toStrictEqual({ id: 'file-1', users: grant });
    expect(db.fabFiles.update.mock.calls[1][0]).toStrictEqual({ id: 'prompt-1', users: grant });
    expect(db.sessions.update).toHaveBeenCalledTimes(1);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({ id: 'session-1', users: grant });
  });
});

describe("sharingService - acceptInvite (non-owner inviter's current access)", () => {
  const userId = 'user-1';
  const ownerId = 'owner-1';
  const sharerId = 'sharer-1';
  const docId = 'doc-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  const makeInvite = (type: InviteType, permissions: Permission[], inviterId?: string) => ({
    id: inviteId,
    type,
    documentId: docId,
    isLinkOnly: true,
    permissions,
    remaining: 1,
    accepted: 0,
    inviterId,
    recipients: { pending: [], refused: [], accepted: [] },
  });

  const makeDoc = (sharerPermissions: Permission[] | null) => ({
    id: docId,
    userId: ownerId,
    users: sharerPermissions ? [{ userId: sharerId, permissions: sharerPermissions }] : [],
    groups: [],
    knowledgeIds: [],
    fileIds: [],
    systemPrompts: [],
    sessionIds: [],
  });

  const makeAdapters = (
    type: InviteType,
    invitePermissions: Permission[],
    doc: unknown,
    inviterId?: string,
    inviterGroups: string[] = []
  ) => ({
    db: {
      invites: {
        findById: vi.fn(async () => makeInvite(type, invitePermissions, inviterId)),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
      },
      fabFiles: { findById: vi.fn(async () => doc), findAllByIds: vi.fn(async () => []), update: vi.fn() },
      sessions: { findById: vi.fn(async () => doc), findAllByIds: vi.fn(async () => []), update: vi.fn() },
      projects: { findById: vi.fn(async () => doc), update: vi.fn() },
      groups: { findById: vi.fn() },
      organization: { findById: vi.fn(), update: vi.fn(), ensureUserDetails: vi.fn() },
      users: {
        findById: vi.fn(async (id: string) =>
          id === userId ? { id: userId, email: 'a@x.com', username: 'a' } : { id, groups: inviterGroups }
        ),
        update: vi.fn(),
      },
    },
  });

  const shareLink = [Permission.read, Permission.share];

  it.each([InviteType.Session, InviteType.FabFile, InviteType.Project])(
    'refuses a %s link whose minter has since been revoked, and grants nothing',
    async type => {
      const adapters = makeAdapters(type, shareLink, makeDoc(null), sharerId);

      await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
      expect(adapters.db.sessions.update).not.toHaveBeenCalled();
      expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
      expect(adapters.db.projects.update).not.toHaveBeenCalled();
      expect(adapters.db.invites.update).not.toHaveBeenCalled();
    }
  );

  const fullLink = [Permission.read, Permission.update, Permission.share];
  const docUpdate = (type: InviteType, adapters: ReturnType<typeof makeAdapters>) =>
    (type === InviteType.FabFile ? adapters.db.fabFiles.update : adapters.db.projects.update).mock.calls[0][0];
  const acceptedRow = (permissions: Permission[]) => ({
    userId,
    permissions,
    projectId: undefined,
    sessionId: undefined,
  });

  it.each([InviteType.FabFile, InviteType.Project])(
    'grants a %s link whose minter still holds share, and spends the slot',
    async type => {
      const adapters = makeAdapters(type, shareLink, makeDoc(shareLink), sharerId);

      await acceptInvite(userId, { id: inviteId }, adapters as never);

      expect(docUpdate(type, adapters).users).toStrictEqual([
        { userId: sharerId, permissions: shareLink },
        acceptedRow(shareLink),
      ]);
      expect(adapters.db.invites.update).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0, accepted: 1 }));
    }
  );

  it('accepts an empty non-owner invite as a no-op grant, like an owner-minted one', async () => {
    const adapters = makeAdapters(InviteType.FabFile, [], makeDoc(null), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.fabFiles.update.mock.calls[0][0].users).toStrictEqual([acceptedRow([])]);
  });

  it.each([InviteType.FabFile, InviteType.Project])('caps a %s link to what the minter currently holds', async type => {
    const adapters = makeAdapters(type, fullLink, makeDoc(shareLink), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docUpdate(type, adapters).users).toStrictEqual([
      { userId: sharerId, permissions: shareLink },
      acceptedRow(shareLink),
    ]);
  });

  it.each([InviteType.FabFile, InviteType.Project])(
    'refuses a %s link whose minter account no longer exists',
    async type => {
      const adapters = makeAdapters(type, shareLink, makeDoc(shareLink), sharerId);
      adapters.db.users.findById.mockImplementation(async (id: string) =>
        id === userId ? { id: userId, email: 'a@x.com', username: 'a' } : (null as never)
      );

      await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
      expect(adapters.db.fabFiles.update).not.toHaveBeenCalled();
      expect(adapters.db.projects.update).not.toHaveBeenCalled();
      expect(adapters.db.invites.update).not.toHaveBeenCalled();
    }
  );

  it.each([InviteType.FabFile, InviteType.Project])(
    'honors a %s link whose minter still holds share through a group',
    async type => {
      const doc = { ...makeDoc(null), groups: [{ groupId: 'group-1', permissions: shareLink }] };
      const adapters = makeAdapters(type, shareLink, doc, sharerId, ['group-1']);

      await acceptInvite(userId, { id: inviteId }, adapters as never);

      expect(docUpdate(type, adapters).users).toStrictEqual([acceptedRow(shareLink)]);
    }
  );

  it("propagates a capped Project grant to the project's files, prompts and notebooks", async () => {
    const project = {
      ...makeDoc(shareLink),
      fileIds: ['file-1'],
      systemPrompts: [{ fileId: 'prompt-1' }],
      sessionIds: ['session-1'],
    };
    const adapters = makeAdapters(InviteType.Project, fullLink, project, sharerId);
    adapters.db.fabFiles.findAllByIds.mockResolvedValue([
      { id: 'file-1', users: [] },
      { id: 'prompt-1', users: [] },
    ] as never);
    adapters.db.sessions.findAllByIds.mockResolvedValue([{ id: 'session-1', users: [] }] as never);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    const propagated = [{ userId, permissions: shareLink, projectId: docId, sessionId: undefined }];
    expect(adapters.db.fabFiles.findAllByIds).toHaveBeenCalledWith(['file-1', 'prompt-1']);
    expect(adapters.db.fabFiles.update.mock.calls.map(([arg]) => arg)).toStrictEqual([
      { id: 'file-1', users: propagated },
      { id: 'prompt-1', users: propagated },
    ]);
    expect(adapters.db.sessions.findAllByIds).toHaveBeenCalledWith(['session-1']);
    expect(adapters.db.sessions.update.mock.calls[0][0]).toStrictEqual({ id: 'session-1', users: propagated });
  });

  it("caps a non-owner's Session link on knowledge files to what the minter holds on each", async () => {
    const session = { ...makeDoc(fullLink), knowledgeIds: ['shared-file', 'read-only-file'] };
    const files: Record<string, unknown> = {
      'shared-file': { id: 'shared-file', userId: 'someone', users: [{ userId: sharerId, permissions: shareLink }] },
      'read-only-file': {
        id: 'read-only-file',
        userId: 'someone',
        users: [{ userId: sharerId, permissions: [Permission.read] }],
      },
    };
    const adapters = makeAdapters(InviteType.Session, fullLink, session, sharerId);
    adapters.db.fabFiles.findById.mockImplementation(async (id: string) => files[id] as never);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.update.mock.calls[0][0]).toStrictEqual({
      id: 'shared-file',
      users: [
        { userId: sharerId, permissions: shareLink },
        { userId, permissions: shareLink, projectId: undefined, sessionId: docId },
      ],
    });
    expect(adapters.db.sessions.update.mock.calls[0][0].users).toContainEqual(acceptedRow(fullLink));
  });

  it('looks a Session inviter up once for both the re-check and file propagation', async () => {
    const adapters = makeAdapters(InviteType.Session, shareLink, makeDoc(shareLink), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.users.findById.mock.calls.filter(([id]) => id === sharerId)).toHaveLength(1);
    expect(adapters.db.sessions.update).toHaveBeenCalled();
  });

  it('refuses a link whose minter account no longer exists', async () => {
    const adapters = makeAdapters(
      InviteType.Session,
      shareLink,
      makeDoc([Permission.read, Permission.share]),
      sharerId
    );
    adapters.db.users.findById.mockImplementation(async (id: string) =>
      id === userId ? { id: userId, email: 'a@x.com', username: 'a' } : (null as never)
    );

    await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.sessions.update).not.toHaveBeenCalled();
  });

  it('honors a link whose minter still holds share through a group', async () => {
    const doc = { ...makeDoc(null), groups: [{ groupId: 'group-1', permissions: shareLink }] };
    const adapters = makeAdapters(InviteType.Session, shareLink, doc, sharerId, ['group-1']);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.sessions.update.mock.calls[0][0].users).toStrictEqual([
      { userId, permissions: shareLink, projectId: undefined, sessionId: undefined },
    ]);
  });

  it('refuses a link whose minter was narrowed to read-only', async () => {
    const adapters = makeAdapters(InviteType.Session, shareLink, makeDoc([Permission.read]), sharerId);

    await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.sessions.update).not.toHaveBeenCalled();
  });

  it('caps the grant to what the minter currently holds, dropping update they no longer have', async () => {
    const adapters = makeAdapters(
      InviteType.Session,
      [Permission.read, Permission.update, Permission.share],
      makeDoc([Permission.read, Permission.share]),
      sharerId
    );

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.sessions.update.mock.calls[0][0].users).toStrictEqual([
      { userId: sharerId, permissions: [Permission.read, Permission.share] },
      { userId, permissions: [Permission.read, Permission.share], projectId: undefined, sessionId: undefined },
    ]);
  });

  it.each([
    ['owner-minted', ownerId],
    ['legacy (no inviterId)', undefined],
  ])('grants a %s invite at face value', async (_label, inviterId) => {
    const adapters = makeAdapters(InviteType.FabFile, shareLink, makeDoc(null), inviterId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.fabFiles.update.mock.calls[0][0].users).toStrictEqual([
      { userId, permissions: shareLink, projectId: undefined, sessionId: undefined },
    ]);
  });
});
