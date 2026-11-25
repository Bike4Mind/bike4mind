import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, InviteType, ISpaceDocument, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { adminRemove } from './adminRemove';
import { adminRemoveMember } from './adminRemoveMember';

const platformAdmin = { id: 'platform-admin', isAdmin: true } as IUserDocument;

const freshSpace = (): ISpaceDocument =>
  ({
    id: 'space1',
    name: 'Team',
    ownerUserId: 'owner',
    members: [
      { userId: 'admin', role: 'admin', joinedVia: 'invite', joinedAt: new Date() },
      { userId: 'member', role: 'member', joinedVia: 'link', joinedAt: new Date() },
    ],
    removedUserIds: [],
  }) as unknown as ISpaceDocument;

describe('admin Space removal', () => {
  let space: ISpaceDocument | null;
  let db: ReturnType<typeof buildDb>;

  const buildDb = () => ({
    spaces: {
      findLiveById: vi.fn(async () => space),
      softDelete: vi.fn(async () => true),
      removeMember: vi.fn(async () => space),
    },
    invites: {
      revokeAllForDocument: vi.fn(async () => 1),
      findAllByDocumentId: vi.fn(async () => [] as never[]),
      cancelPendingRecipient: vi.fn(),
    },
    orgDomainClaims: { deleteBySpace: vi.fn(async () => 1) },
    users: { findById: vi.fn(async (id: string) => ({ id, email: 'Member@Example.com' }) as IUserDocument) },
  });

  beforeEach(() => {
    space = freshSpace();
    db = buildDb();
  });

  describe('adminRemove', () => {
    it('deletes for a non-member admin, revokes invites and claims, and returns the Space', async () => {
      const deleted = await adminRemove(platformAdmin, { spaceId: 'space1' }, { db });
      expect(deleted.name).toBe('Team');
      expect(db.spaces.softDelete).toHaveBeenCalledWith('space1', 'owner');
      expect(db.invites.revokeAllForDocument).toHaveBeenCalledWith('space1', InviteType.Space);
      expect(db.orgDomainClaims.deleteBySpace).toHaveBeenCalledWith('space1');
    });

    it('is NotFound for a deleted Space and writes nothing', async () => {
      space = null;
      await expect(adminRemove(platformAdmin, { spaceId: 'space1' }, { db })).rejects.toBeInstanceOf(NotFoundError);
      expect(db.spaces.softDelete).not.toHaveBeenCalled();
      expect(db.invites.revokeAllForDocument).not.toHaveBeenCalled();
    });
  });

  describe('adminRemoveMember', () => {
    it('blocks the user with no actor and cancels their pending named invite', async () => {
      db.invites.findAllByDocumentId.mockResolvedValue([
        { id: 'inv1', recipients: { pending: ['member@example.com'] } },
        { id: 'inv2', revokedAt: new Date(), recipients: { pending: ['member@example.com'] } },
        { id: 'inv3', recipients: { pending: ['other@example.com'] } },
      ] as never[]);
      await adminRemoveMember(platformAdmin, { spaceId: 'space1', userId: 'member' }, { db });
      expect(db.spaces.removeMember).toHaveBeenCalledWith('space1', 'member', { block: true });
      expect(db.invites.cancelPendingRecipient).toHaveBeenCalledTimes(1);
      expect(db.invites.cancelPendingRecipient).toHaveBeenCalledWith('inv1', 'member@example.com');
    });

    it('removes a Space admin too', async () => {
      await adminRemoveMember(platformAdmin, { spaceId: 'space1', userId: 'admin' }, { db });
      expect(db.spaces.removeMember).toHaveBeenCalledWith('space1', 'admin', { block: true });
    });

    it('refuses the owner', async () => {
      await expect(
        adminRemoveMember(platformAdmin, { spaceId: 'space1', userId: 'owner' }, { db })
      ).rejects.toMatchObject({ constructor: ForbiddenError, message: expect.stringContaining('transfer') });
      expect(db.spaces.removeMember).not.toHaveBeenCalled();
    });

    it('is NotFound for a deleted Space or a non-member', async () => {
      await expect(
        adminRemoveMember(platformAdmin, { spaceId: 'space1', userId: 'nobody' }, { db })
      ).rejects.toBeInstanceOf(NotFoundError);
      space = null;
      await expect(
        adminRemoveMember(platformAdmin, { spaceId: 'space1', userId: 'member' }, { db })
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(db.spaces.removeMember).not.toHaveBeenCalled();
    });
  });
});
