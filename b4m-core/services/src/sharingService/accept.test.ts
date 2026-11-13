import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { InviteType, Permission } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError, UnprocessableEntityError } from '@bike4mind/utils';
import { ConflictError } from '@bike4mind/common';
import { acceptInvite } from './accept';
import { setOrgEventObserver, type OrgEvent } from '../organizationService/orgEventObserver';

const shares = () => ({ updateUserShares: vi.fn(async () => ({})) });
const acceptRecipientMock = () => vi.fn(async (id: string) => ({ id }));

describe('sharingService - acceptInvite (Organization)', () => {
  const userId = 'user-123';
  const organizationId = 'org-456';
  const inviteId = '65a1f77bcf86cd7994390789';

  let mockAdapters: {
    db: {
      invites: {
        findById: Mock;
        findByToken: Mock;
        update: Mock;
        acceptRecipient: Mock;
        findAllByDocumentId: Mock;
        cancelPendingRecipient: Mock;
      };
      sessions: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock; findAllByIds: Mock };
      projects: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock };
      fabFiles: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock; findAllByIds: Mock };
      groups: { findById: Mock };
      organization: { findById: Mock; addMemberIfUnderCeiling: Mock; ensureUserDetails: Mock };
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

  const makeInvite = (overrides: Record<string, unknown> = {}) => ({
    id: inviteId,
    type: InviteType.Organization,
    documentId: organizationId,
    permissions: [Permission.read],
    remaining: 5,
    accepted: 0,
    inviterId: 'minter',
    recipients: { pending: ['member@example.com'], refused: [], accepted: [] },
    ...overrides,
  });

  const asAdapters = () => mockAdapters as unknown as Parameters<typeof acceptInvite>[2];

  const makeOrganization = (overrides: Record<string, unknown> = {}) => ({
    id: organizationId,
    userId: 'minter',
    users: [],
    userDetails: [],
    seats: 10,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapters = {
      db: {
        invites: {
          findById: vi.fn(),
          findByToken: vi.fn(async () => null),
          update: vi.fn(),
          acceptRecipient: acceptRecipientMock(),
          findAllByDocumentId: vi.fn(async () => []),
          cancelPendingRecipient: vi.fn(async () => null),
        },
        sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
        fabFiles: { shareable: shares(), findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        groups: { findById: vi.fn() },
        organization: {
          findById: vi.fn(),
          addMemberIfUnderCeiling: vi.fn(async () => ({})),
          ensureUserDetails: vi.fn(),
        },
        users: { findById: vi.fn(), update: vi.fn() },
      },
    };
  });

  it("sets the accepting user's organizationId and persists the user", async () => {
    const user = makeUser();
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      id === 'minter' ? makeUser({ id: 'minter' }) : user
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, organizationId });
    expect(mockAdapters.db.users.update.mock.calls[0][1]).toBeUndefined();
    expect(mockAdapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'member@example.com');
  });

  it('joins through the conditional seat-checked add, with no reservation for a named invite', async () => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.organization.addMemberIfUnderCeiling).toHaveBeenCalledWith(
      organizationId,
      { userId, permissions: [Permission.read] },
      0
    );
    // A named invite's seat was reserved at mint, so its accept never counts the other invites.
    expect(mockAdapters.db.invites.findAllByDocumentId).not.toHaveBeenCalled();
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
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
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
  });

  it('adds the member before persisting the user (membership is fully provisioned)', async () => {
    const callOrder: string[] = [];
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());
    mockAdapters.db.organization.addMemberIfUnderCeiling.mockImplementation(async () => {
      callOrder.push('organization.add');
      return {};
    });
    mockAdapters.db.users.update.mockImplementation(async () => {
      callOrder.push('users.update');
    });

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(callOrder).toEqual(['organization.add', 'users.update']);
  });

  it('overwrites a previously selected organizationId with the newly accepted one', async () => {
    // organizationId is the *currently selected* org; accepting a new invite
    // selects that org, matching organizationService.addMember.
    const user = makeUser({ organizationId: 'previous-org' });
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      id === 'minter' ? makeUser({ id: 'minter' }) : user
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

    await acceptInvite(userId, { id: inviteId }, mockAdapters as any);

    expect(mockAdapters.db.users.update).toHaveBeenCalledTimes(1);
    expect(mockAdapters.db.users.update.mock.calls[0][0]).toStrictEqual({ id: userId, organizationId });
  });

  it('throws when the organization is full and does not update the user', async () => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());
    mockAdapters.db.organization.addMemberIfUnderCeiling.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow('Organization is full');
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    expect(mockAdapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  const linkOnly = { isLinkOnly: true, recipients: { pending: [], refused: [], accepted: [] } };

  it('reports a concurrent link join of the same user as already a member, not as full', async () => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite(linkOnly));
    mockAdapters.db.organization.findById
      .mockResolvedValueOnce(makeOrganization())
      .mockResolvedValueOnce(makeOrganization({ users: [{ userId }] }));
    mockAdapters.db.organization.addMemberIfUnderCeiling.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).rejects.toThrow(ConflictError);
  });

  it.each([
    ['a member', makeOrganization({ users: [{ userId }] })],
    ['the owner', makeOrganization({ userId })],
  ])('refuses %s joining by link with 409 before any write', async (_label, organization) => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite(linkOnly));
    mockAdapters.db.organization.findById.mockResolvedValue(organization);

    await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).rejects.toThrow(ConflictError);
    expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    expect(mockAdapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it.each([
    ['a member', makeOrganization({ users: [{ userId }] })],
    ['the owner', makeOrganization({ userId })],
  ])(
    'consumes a named Editor invite sent to %s, keeps their role and reports already-member',
    async (_label, organization) => {
      mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
        makeUser(id === 'minter' ? { id: 'minter' } : {})
      );
      mockAdapters.db.invites.findById.mockResolvedValue(
        makeInvite({ permissions: [Permission.read, Permission.update, Permission.share] })
      );
      mockAdapters.db.organization.findById.mockResolvedValue(organization);

      await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).resolves.toEqual({
        invite: { id: inviteId },
        outcome: 'already-member',
      });
      expect(mockAdapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'member@example.com');
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
      if (_label === 'a member')
        expect(mockAdapters.db.organization.ensureUserDetails).toHaveBeenCalledWith(organizationId, {
          id: userId,
          email: 'member@example.com',
          name: 'Member',
        });
      else expect(mockAdapters.db.organization.ensureUserDetails).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    }
  );

  it('consumes a named invite when a concurrent join already added the user', async () => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById
      .mockResolvedValueOnce(makeOrganization())
      .mockResolvedValueOnce(makeOrganization({ users: [{ userId }] }));
    mockAdapters.db.organization.addMemberIfUnderCeiling.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).resolves.toEqual({
      invite: { id: inviteId },
      outcome: 'already-member',
    });
    expect(mockAdapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'member@example.com');
  });

  it.each([
    ['owner', { userId: 'minter', users: [] }, { id: 'minter' }, [Permission.read, Permission.update], true],
    [
      'current manager',
      { userId: 'owner', adminUserIds: ['minter'], users: [{ userId: 'minter', permissions: [Permission.read] }] },
      { id: 'minter' },
      [Permission.read],
      true,
    ],
    [
      'removed manager',
      { userId: 'owner', adminUserIds: ['minter'], users: [] },
      { id: 'minter' },
      [Permission.read],
      false,
    ],
    [
      'demoted manager',
      { userId: 'owner', adminUserIds: [], users: [{ userId: 'minter', permissions: [Permission.read] }] },
      { id: 'minter' },
      [Permission.read],
      false,
    ],
    [
      'manager above Viewer',
      { userId: 'owner', adminUserIds: ['minter'], users: [{ userId: 'minter', permissions: [Permission.read] }] },
      { id: 'minter' },
      [Permission.read, Permission.update],
      false,
    ],
    [
      'platform admin',
      { userId: 'owner', users: [] },
      { id: 'minter', isAdmin: true },
      [Permission.read, Permission.update],
      true,
    ],
    ['deleted minter', { userId: 'minter', users: [] }, null, [Permission.read], false],
  ] as const)(
    'checks the current authority of a link minter: %s',
    async (_label, organization, minter, permissions, allowed) => {
      mockAdapters.db.users.findById.mockImplementation(async (id: string) => (id === 'minter' ? minter : makeUser()));
      mockAdapters.db.invites.findById.mockResolvedValue(makeInvite({ ...linkOnly, permissions }));
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization(organization));
      const completion = acceptInvite(userId, { id: inviteId }, asAdapters());
      if (allowed) {
        await expect(completion).resolves.toMatchObject({ outcome: 'accepted' });
        expect(mockAdapters.db.organization.addMemberIfUnderCeiling).toHaveBeenCalledOnce();
      } else {
        await expect(completion).rejects.toThrow(ForbiddenError);
        expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
        expect(mockAdapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
      }
    }
  );

  it.each([0, 3])(
    'returns the member outcome when reopening a previously accepted link with %s remaining slots',
    async remaining => {
      mockAdapters.db.users.findById.mockResolvedValue(makeUser());
      mockAdapters.db.invites.findById.mockResolvedValue(
        makeInvite({ ...linkOnly, remaining, recipients: { accepted: ['MEMBER@example.com'] } })
      );
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization({ users: [{ userId }] }));
      await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).rejects.toThrow(ConflictError);
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
      expect(mockAdapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    }
  );

  describe('share link', () => {
    const linkInvite = (overrides: Record<string, unknown> = {}) =>
      makeInvite({ isLinkOnly: true, recipients: { pending: [], refused: [], accepted: [] }, ...overrides });

    const accept = async (invite: Record<string, unknown>, user = makeUser()) => {
      mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
        id === 'minter' ? makeUser({ id: 'minter' }) : user
      );
      mockAdapters.db.invites.findById.mockResolvedValue(invite);
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());
      return acceptInvite(userId, { id: inviteId }, asAdapters());
    };

    it('holds back seats for live named invites other than the accepter', async () => {
      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);
      mockAdapters.db.invites.findAllByDocumentId.mockResolvedValue([
        { type: InviteType.Organization, remaining: 2, recipients: { pending: ['a@x.com', 'B@x.com'] } },
        { type: InviteType.Organization, remaining: 1, expiresAt: future, recipients: { pending: ['b@x.com'] } },
        { type: InviteType.Organization, remaining: 1, recipients: { pending: ['Member@example.com'] } },
        { type: InviteType.Organization, remaining: 1, expiresAt: past, recipients: { pending: ['expired@x.com'] } },
        { type: InviteType.Organization, remaining: 0, recipients: { pending: ['spent@x.com'] } },
        { type: InviteType.Organization, remaining: 1, revokedAt: past, recipients: { pending: ['rev@x.com'] } },
        { type: InviteType.Group, remaining: 1, recipients: { pending: ['group@x.com'] } },
      ]);

      await accept(linkInvite());

      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).toHaveBeenCalledWith(
        organizationId,
        { userId, permissions: [Permission.read] },
        2
      );
      expect(mockAdapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'member@example.com');
    });

    it('clears the joiner from their own pending named invites so those stop holding a seat', async () => {
      mockAdapters.db.invites.findAllByDocumentId.mockResolvedValue([
        {
          id: 'named-own',
          type: InviteType.Organization,
          remaining: 1,
          recipients: { pending: [' Member@Example.com'] },
        },
        { id: 'named-other', type: InviteType.Organization, remaining: 1, recipients: { pending: ['a@x.com'] } },
      ]);

      await accept(linkInvite());

      expect(mockAdapters.db.invites.cancelPendingRecipient).toHaveBeenCalledTimes(1);
      expect(mockAdapters.db.invites.cancelPendingRecipient).toHaveBeenCalledWith('named-own', 'member@example.com');
    });

    it('leaves pending named invites alone when the seat check refuses the join', async () => {
      mockAdapters.db.invites.findAllByDocumentId.mockResolvedValue([
        {
          id: 'named-own',
          type: InviteType.Organization,
          remaining: 1,
          recipients: { pending: ['member@example.com'] },
        },
      ]);
      mockAdapters.db.organization.addMemberIfUnderCeiling.mockResolvedValue(null);

      await expect(accept(linkInvite())).rejects.toThrow('Organization is full');
      expect(mockAdapters.db.invites.cancelPendingRecipient).not.toHaveBeenCalled();
    });

    it('refuses a revoked link before touching the organization', async () => {
      await expect(accept(linkInvite({ revokedAt: new Date() }))).rejects.toThrow(UnprocessableEntityError);
      await expect(accept(linkInvite({ revokedAt: new Date() }))).rejects.toThrow('Invite has been revoked');
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    });

    it('refuses an expired link', async () => {
      await expect(accept(linkInvite({ expiresAt: new Date(Date.now() - 1000) }))).rejects.toThrow(
        'Invite has expired'
      );
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    });

    it('admits a verified address on an allowed domain', async () => {
      await accept(linkInvite({ allowedDomains: ['example.com'] }), makeUser({ emailVerified: true }));
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).toHaveBeenCalled();
    });

    it.each([
      ['another domain', { email: 'member@other.com', emailVerified: true }],
      ['a subdomain', { email: 'member@eu.example.com', emailVerified: true }],
      ['a lookalike suffix', { email: 'member@badexample.com', emailVerified: true }],
      ['an unverified address', { emailVerified: false }],
      ['a user with no verification flag', {}],
    ])('refuses %s on a domain-limited link', async (_label, overrides) => {
      await expect(accept(linkInvite({ allowedDomains: ['example.com'] }), makeUser(overrides))).rejects.toThrow(
        ForbiddenError
      );
      expect(mockAdapters.db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
      expect(mockAdapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    });
  });

  it('throws NotFoundError when the organization does not exist', async () => {
    mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
      makeUser(id === 'minter' ? { id: 'minter' } : {})
    );
    mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    mockAdapters.db.organization.findById.mockResolvedValue(null);

    await expect(acceptInvite(userId, { id: inviteId }, mockAdapters as any)).rejects.toThrow(NotFoundError);
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
  });
  describe('org admin alerts', () => {
    const events: OrgEvent[] = [];
    beforeEach(() => {
      events.length = 0;
      setOrgEventObserver(event => {
        events.push(event);
      });
      mockAdapters.db.users.findById.mockImplementation(async (id: string) =>
        makeUser(id === 'minter' ? { id: 'minter' } : {})
      );
      mockAdapters.db.invites.findById.mockResolvedValue(makeInvite());
    });
    afterEach(() => setOrgEventObserver(null));

    it('announces the join with the inviter as actor, after the invite is consumed', async () => {
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());

      await acceptInvite(userId, { id: inviteId }, asAdapters());

      expect(events).toEqual([{ type: 'member_joined', organizationId, userId, actorUserId: 'minter' }]);
    });

    it('announces nothing when the invite has no remaining slot', async () => {
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization());
      mockAdapters.db.invites.acceptRecipient.mockResolvedValue(null);

      await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).rejects.toThrow(UnprocessableEntityError);
      expect(events).toEqual([]);
    });

    it('announces nothing for an existing member', async () => {
      mockAdapters.db.organization.findById.mockResolvedValue(
        makeOrganization({ users: [{ userId, permissions: [Permission.read] }] })
      );

      await acceptInvite(userId, { id: inviteId }, asAdapters());

      expect(events).toEqual([]);
    });

    it('raises seat_limit before refusing a full organization', async () => {
      mockAdapters.db.organization.findById.mockResolvedValue(makeOrganization({ seats: 3 }));
      mockAdapters.db.organization.addMemberIfUnderCeiling.mockResolvedValue(null);

      await expect(acceptInvite(userId, { id: inviteId }, asAdapters())).rejects.toThrow('Organization is full');
      expect(events).toEqual([{ type: 'seat_limit', organizationId, seats: 3 }]);
    });
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
      invites: { findById: Mock; findByToken: Mock; update: Mock; acceptRecipient: Mock };
      sessions: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock; findAllByIds: Mock };
      projects: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock };
      fabFiles: { shareable: { updateUserShares: Mock }; findById: Mock; update: Mock; findAllByIds: Mock };
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
        invites: {
          findById: vi.fn(),
          findByToken: vi.fn(async () => null),
          update: vi.fn(),
          acceptRecipient: acceptRecipientMock(),
        },
        sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
        projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
        fabFiles: { shareable: shares(), findById: vi.fn(), update: vi.fn(), findAllByIds: vi.fn() },
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
    expect(mockAdapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'member@example.com');
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
      invites: {
        findById: vi.fn(),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
        acceptRecipient: acceptRecipientMock(),
      },
      fabFiles: { shareable: shares(), findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
      projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
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
    expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
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
    expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('admits a recipient whose stored email differs only in case from the pending address', async () => {
    // A Project invite to an address with no account stores it lowercased; an SSO signup keeps the
    // provider's casing.
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('New.Person@Example.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite(['new.person@example.com', 'b@x.com'], 2));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'New.Person@Example.com');
  });

  it('allows an accepter who is one of the named pending recipients', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('a@x.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite(['a@x.com', 'b@x.com'], 2));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'a@x.com');
    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledWith(fileId, {
      add: [{ userId, permissions: [Permission.read, Permission.share] }],
    });
  });

  it('allows anyone to accept a link-only invite (pending was never populated)', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser('anyone@x.com'));
    adapters.db.invites.findById.mockResolvedValue(makeInvite([], 1000));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'anyone@x.com');
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
    expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
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
      invites: {
        findById: vi.fn(),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
        acceptRecipient: acceptRecipientMock(),
      },
      fabFiles: { shareable: shares(), findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
      projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
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
    expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('allows redemption of an invite whose expiresAt is in the future', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser());
    adapters.db.invites.findById.mockResolvedValue(makeInvite(new Date(Date.now() + 1000 * 60 * 60)));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'a@x.com');
  });

  it('allows redemption of an invite with no expiresAt set', async () => {
    const adapters = makeAdapters();
    adapters.db.users.findById.mockResolvedValue(makeUser());
    adapters.db.invites.findById.mockResolvedValue(makeInvite(undefined));

    await acceptInvite(userId, { id: inviteId }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'a@x.com');
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
      invites: {
        findById: vi.fn(),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
        acceptRecipient: acceptRecipientMock(),
      },
      fabFiles: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
      sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
      projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
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

    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
    // The session share itself still goes through - only the file grant is skipped.
    expect(adapters.db.sessions.shareable.updateUserShares).toHaveBeenCalledTimes(1);
    expect(adapters.db.sessions.shareable.updateUserShares).toHaveBeenCalledWith(sessionId, {
      add: [{ userId, permissions: [Permission.read, Permission.update, Permission.share] }],
    });
    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'accepter@x.com');
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

    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
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

    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledWith('file-shared', {
      add: [{ userId, permissions: [Permission.read, Permission.share], sessionId }],
    });
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

    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledTimes(1);
    // sessionId is the provenance tag, asserted here because this is its only write site: without
    // it the row is untagged, merges with a direct share, and both cascades delete the pair.
    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledWith('file-owned', {
      add: [{ userId, permissions: [Permission.read, Permission.update, Permission.share], sessionId }],
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

    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledTimes(1);
    expect(adapters.db.fabFiles.shareable.updateUserShares).toHaveBeenCalledWith('file-owned', {
      add: [{ userId, permissions: [Permission.read, Permission.update, Permission.share], sessionId }],
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
      invites: {
        findById: vi.fn(async () => null),
        findByToken: vi.fn(async () => null),
        update: vi.fn(),
        acceptRecipient: acceptRecipientMock(),
      },
      fabFiles: { shareable: shares(), findById: vi.fn(async () => ({ id: fileId, users: [] })), update: vi.fn() },
      sessions: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
      projects: { shareable: shares(), findById: vi.fn(), update: vi.fn() },
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

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(ID, 'me@example.com');
  });

  it('accepts that same invite by id, as the inbox addresses it', async () => {
    const adapters = makeAdapters();
    adapters.db.invites.findById = vi.fn(async () => tokenizedNamedInvite()) as never;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await acceptInvite('user-1', { id: ID }, adapters as any);

    expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(ID, 'me@example.com');
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
    expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
  });
});

describe('sharingService - acceptInvite (Project)', () => {
  const userId = 'user-1';
  const projectId = 'project-1';
  const inviteId = '65a1f77bcf86cd7994390001';

  it('records the accept and grants the project and each attached file and session', async () => {
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
        acceptRecipient: acceptRecipientMock(),
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
        shareable: shares(),
      },
      fabFiles: {
        shareable: shares(),
        findAllByIds: vi.fn(async () => [
          { id: 'file-1', users: [] },
          { id: 'prompt-1', users: [] },
        ]),
        update: vi.fn(),
      },
      sessions: {
        shareable: shares(),
        findAllByIds: vi.fn(async () => [{ id: 'session-1', users: [] }]),
        update: vi.fn(),
      },
      users: { findById: vi.fn(async () => ({ id: userId, email: 'a@x.com', username: 'a' })), update: vi.fn() },
    };

    await acceptInvite(userId, { id: inviteId }, { db } as never);

    const grant = { add: [{ userId, permissions: [Permission.read], projectId }] };
    expect(db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'a@x.com');
    expect(db.projects.shareable.updateUserShares.mock.calls).toStrictEqual([
      [projectId, { add: [{ userId, permissions: [Permission.read] }] }],
    ]);
    expect(db.fabFiles.shareable.updateUserShares.mock.calls).toStrictEqual([
      ['file-1', grant],
      ['prompt-1', grant],
    ]);
    expect(db.sessions.shareable.updateUserShares.mock.calls).toStrictEqual([['session-1', grant]]);
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
        acceptRecipient: acceptRecipientMock(),
      },
      fabFiles: {
        shareable: shares(),
        findById: vi.fn(async () => doc),
        findAllByIds: vi.fn(async () => []),
        update: vi.fn(),
      },
      sessions: {
        shareable: shares(),
        findById: vi.fn(async () => doc),
        findAllByIds: vi.fn(async () => []),
        update: vi.fn(),
      },
      projects: { shareable: shares(), findById: vi.fn(async () => doc), update: vi.fn() },
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
      expect(adapters.db.sessions.shareable.updateUserShares).not.toHaveBeenCalled();
      expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
      expect(adapters.db.projects.shareable.updateUserShares).not.toHaveBeenCalled();
      expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    }
  );

  const fullLink = [Permission.read, Permission.update, Permission.share];
  const docGrant = (type: InviteType, adapters: ReturnType<typeof makeAdapters>) =>
    ({
      [InviteType.FabFile]: adapters.db.fabFiles,
      [InviteType.Project]: adapters.db.projects,
      [InviteType.Session]: adapters.db.sessions,
    })[type as InviteType.FabFile].shareable.updateUserShares.mock.calls[0] as unknown[];
  const granted = (permissions: Permission[]) => [docId, { add: [{ userId, permissions }] }];

  it.each([InviteType.FabFile, InviteType.Project])(
    'grants a %s link whose minter still holds share, and spends the slot',
    async type => {
      const adapters = makeAdapters(type, shareLink, makeDoc(shareLink), sharerId);

      await acceptInvite(userId, { id: inviteId }, adapters as never);

      expect(docGrant(type, adapters)).toStrictEqual(granted(shareLink));
      expect(adapters.db.invites.acceptRecipient).toHaveBeenCalledWith(inviteId, 'a@x.com');
    }
  );

  it('accepts an empty non-owner invite as a no-op grant, like an owner-minted one', async () => {
    const adapters = makeAdapters(InviteType.FabFile, [], makeDoc(shareLink), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docGrant(InviteType.FabFile, adapters)).toStrictEqual(granted([]));
  });

  it('still refuses an empty invite whose minter has lost share', async () => {
    const adapters = makeAdapters(InviteType.FabFile, [], makeDoc([Permission.read]), sharerId);

    await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it.each([InviteType.FabFile, InviteType.Project])('caps a %s link to what the minter currently holds', async type => {
    const adapters = makeAdapters(type, fullLink, makeDoc(shareLink), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docGrant(type, adapters)).toStrictEqual(granted(shareLink));
  });

  it.each([InviteType.FabFile, InviteType.Project])(
    'refuses a %s link whose minter account no longer exists',
    async type => {
      const adapters = makeAdapters(type, shareLink, makeDoc(shareLink), sharerId);
      adapters.db.users.findById.mockImplementation(async (id: string) =>
        id === userId ? { id: userId, email: 'a@x.com', username: 'a' } : (null as never)
      );

      await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
      expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
      expect(adapters.db.projects.shareable.updateUserShares).not.toHaveBeenCalled();
      expect(adapters.db.invites.acceptRecipient).not.toHaveBeenCalled();
    }
  );

  it.each([InviteType.FabFile, InviteType.Project])(
    'honors a %s link whose minter still holds share through a group',
    async type => {
      const doc = { ...makeDoc(null), groups: [{ groupId: 'group-1', permissions: shareLink }] };
      const adapters = makeAdapters(type, shareLink, doc, sharerId, ['group-1']);

      await acceptInvite(userId, { id: inviteId }, adapters as never);

      expect(docGrant(type, adapters)).toStrictEqual(granted(shareLink));
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

    const propagated = { add: [{ userId, permissions: shareLink, projectId: docId }] };
    expect(adapters.db.fabFiles.findAllByIds).toHaveBeenCalledWith(['file-1', 'prompt-1']);
    expect(adapters.db.fabFiles.shareable.updateUserShares.mock.calls).toStrictEqual([
      ['file-1', propagated],
      ['prompt-1', propagated],
    ]);
    expect(adapters.db.sessions.findAllByIds).toHaveBeenCalledWith(['session-1']);
    expect(adapters.db.sessions.shareable.updateUserShares.mock.calls).toStrictEqual([['session-1', propagated]]);
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

    expect(adapters.db.fabFiles.shareable.updateUserShares.mock.calls).toStrictEqual([
      ['shared-file', { add: [{ userId, permissions: shareLink, sessionId: docId }] }],
    ]);
    expect(docGrant(InviteType.Session, adapters)).toStrictEqual(granted(fullLink));
  });

  it('looks a Session inviter up once for both the re-check and file propagation', async () => {
    const adapters = makeAdapters(InviteType.Session, shareLink, makeDoc(shareLink), sharerId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(adapters.db.users.findById.mock.calls.filter(([id]) => id === sharerId)).toHaveLength(1);
    expect(adapters.db.sessions.shareable.updateUserShares).toHaveBeenCalled();
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
    expect(adapters.db.sessions.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('honors a link whose minter still holds share through a group', async () => {
    const doc = { ...makeDoc(null), groups: [{ groupId: 'group-1', permissions: shareLink }] };
    const adapters = makeAdapters(InviteType.Session, shareLink, doc, sharerId, ['group-1']);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docGrant(InviteType.Session, adapters)).toStrictEqual(granted(shareLink));
  });

  it('refuses a link whose minter was narrowed to read-only', async () => {
    const adapters = makeAdapters(InviteType.Session, shareLink, makeDoc([Permission.read]), sharerId);

    await expect(acceptInvite(userId, { id: inviteId }, adapters as never)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.sessions.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('caps the grant to what the minter currently holds, dropping update they no longer have', async () => {
    const adapters = makeAdapters(
      InviteType.Session,
      [Permission.read, Permission.update, Permission.share],
      makeDoc([Permission.read, Permission.share]),
      sharerId
    );

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docGrant(InviteType.Session, adapters)).toStrictEqual(granted([Permission.read, Permission.share]));
  });

  it.each([
    ['owner-minted', ownerId],
    ['legacy (no inviterId)', undefined],
  ])('grants a %s invite at face value', async (_label, inviterId) => {
    const adapters = makeAdapters(InviteType.FabFile, shareLink, makeDoc(null), inviterId);

    await acceptInvite(userId, { id: inviteId }, adapters as never);

    expect(docGrant(InviteType.FabFile, adapters)).toStrictEqual(granted(shareLink));
  });
});
