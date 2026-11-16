import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictError, ForbiddenError, InviteType } from '@bike4mind/common';
import { acceptInvite } from './accept';

const userId = 'joiner';
const spaceId = '65a1f77bcf86cd7994390010';

const makeUser = (over: Record<string, unknown> = {}) => ({
  id: userId,
  email: 'joiner@example.com',
  emailVerified: true,
  organizationId: 'org-before',
  ...over,
});

const makeSpace = (over: Record<string, unknown> = {}) => ({
  id: spaceId,
  name: 'Team',
  ownerUserId: 'owner',
  members: [{ userId: 'minter', role: 'admin', joinedVia: 'invite', joinedAt: new Date() }],
  removedUserIds: [] as string[],
  ...over,
});

const makeLink = (over: Record<string, unknown> = {}) => ({
  id: 'link1',
  token: 'tok1',
  type: InviteType.Space,
  documentId: spaceId,
  inviterId: 'minter',
  isLinkOnly: true,
  remaining: 5,
  revokedAt: null,
  expiresAt: null,
  recipients: { pending: [], accepted: [], refused: [] },
  permissions: ['read'],
  ...over,
});

describe('sharingService - acceptInvite (Space)', () => {
  let space: ReturnType<typeof makeSpace> | null;
  let invite: Record<string, unknown>;
  let user: ReturnType<typeof makeUser>;
  let db: ReturnType<typeof buildDb>;

  const buildDb = () => ({
    invites: {
      findById: vi.fn(async () => invite),
      findByToken: vi.fn(async () => invite),
      acceptRecipient: vi.fn(async (id: string) => ({ id })),
      cancelPendingRecipient: vi.fn(),
      findAllByDocumentId: vi.fn(async () => []),
    },
    sessions: {},
    projects: {},
    fabFiles: {},
    groups: { findById: vi.fn() },
    organization: { findById: vi.fn(), addMemberIfUnderCeiling: vi.fn(), ensureUserDetails: vi.fn() },
    users: {
      findById: vi.fn(async (id: string) => (id === 'minter' ? makeUser({ id: 'minter' }) : user)),
      update: vi.fn(),
    },
    spaces: {
      findLiveById: vi.fn(async () => space),
      addMember: vi.fn(async () => makeSpace()),
    },
  });

  const run = (limits = { spaceMaxMembers: 1000, spacesEnabled: true }) =>
    acceptInvite(userId, { id: 'tok1' }, { db, limits } as never);

  beforeEach(() => {
    space = makeSpace();
    invite = makeLink();
    user = makeUser();
    db = buildDb();
  });

  it('joins through a link as a link member and spends the slot', async () => {
    await run({ spaceMaxMembers: 7, spacesEnabled: true });
    expect(db.spaces.addMember).toHaveBeenCalledWith(
      spaceId,
      expect.objectContaining({ userId, role: 'member', joinedVia: 'link' }),
      { cap: 7, clearRemoved: false }
    );
    expect(db.invites.acceptRecipient).toHaveBeenCalledWith('link1', 'joiner@example.com', { allowRepeat: true });
  });

  it('never touches the joiner organization pointer, seats or billing', async () => {
    await run();
    expect(db.users.update).not.toHaveBeenCalled();
    expect(db.organization.addMemberIfUnderCeiling).not.toHaveBeenCalled();
    expect(user.organizationId).toBe('org-before');
  });

  it('answers a member re-click with 409 and spends nothing', async () => {
    space = makeSpace({ members: [{ userId, role: 'member', joinedVia: 'link', joinedAt: new Date() }] });
    await expect(run()).rejects.toBeInstanceOf(ConflictError);
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
    expect(db.spaces.addMember).not.toHaveBeenCalled();
  });

  it('lets a leaver rejoin through the same link and spends a second use', async () => {
    invite = makeLink({ recipients: { pending: [], refused: [], accepted: ['joiner@example.com'] } });
    await expect(run()).resolves.toBeTruthy();
    expect(db.spaces.addMember).toHaveBeenCalledTimes(1);
    expect(db.invites.acceptRecipient).toHaveBeenCalledWith('link1', 'joiner@example.com', { allowRepeat: true });
  });

  it('refuses a removed user by link', async () => {
    space = makeSpace({ removedUserIds: [userId] });
    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.spaces.addMember).not.toHaveBeenCalled();
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it('admits a removed user by a named invite and lifts the block', async () => {
    space = makeSpace({ removedUserIds: [userId] });
    invite = makeLink({
      isLinkOnly: false,
      recipients: { pending: ['joiner@example.com'], refused: [], accepted: [] },
    });
    await run();
    expect(db.spaces.addMember).toHaveBeenCalledWith(
      spaceId,
      expect.objectContaining({ joinedVia: 'invite' }),
      expect.objectContaining({ clearRemoved: true })
    );
  });

  it('refuses a named invite whose inviter was demoted', async () => {
    space = makeSpace({ members: [{ userId: 'minter', role: 'member', joinedVia: 'invite', joinedAt: new Date() }] });
    invite = makeLink({
      isLinkOnly: false,
      recipients: { pending: ['joiner@example.com'], refused: [], accepted: [] },
    });
    await expect(run()).rejects.toThrow('The inviter can no longer grant access to this space');
    expect(db.spaces.addMember).not.toHaveBeenCalled();
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it('refuses with the flag off before any write', async () => {
    await expect(run({ spaceMaxMembers: 1000, spacesEnabled: false })).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.spaces.addMember).not.toHaveBeenCalled();
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it('cancels the joiner pending named invites on a link join', async () => {
    db.invites.findAllByDocumentId.mockResolvedValue([
      { id: 'named1', recipients: { pending: [' Joiner@Example.com '] } },
      { id: 'named2', recipients: { pending: ['someone@else.com'] } },
      { id: 'named3', revokedAt: new Date(), recipients: { pending: ['joiner@example.com'] } },
    ] as never);
    await run();
    expect(db.invites.cancelPendingRecipient).toHaveBeenCalledTimes(1);
    expect(db.invites.cancelPendingRecipient).toHaveBeenCalledWith('named1', 'joiner@example.com');
  });

  it('refuses a link whose minter lost admin', async () => {
    space = makeSpace({ members: [{ userId: 'minter', role: 'member', joinedVia: 'invite', joinedAt: new Date() }] });
    await expect(run()).rejects.toThrow('The inviter can no longer grant access to this space');
    expect(db.spaces.addMember).not.toHaveBeenCalled();
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it('refuses when the Space is full', async () => {
    db.spaces.addMember.mockResolvedValue(null as never);
    await expect(run()).rejects.toThrow('This space is full');
    expect(db.invites.acceptRecipient).not.toHaveBeenCalled();
  });

  it('refuses an unverified email and a non-matching domain on a domain-limited link', async () => {
    invite = makeLink({ allowedDomains: ['example.com'] });
    user = makeUser({ emailVerified: false });
    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    user = makeUser({ email: 'joiner@other.com' });
    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.spaces.addMember).not.toHaveBeenCalled();
    user = makeUser();
    await expect(run()).resolves.toBeTruthy();
  });
});
