import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InviteType,
  IOrganizationDocument,
  ISpaceDocument,
  IUserDocument,
  MAX_OWNED_SPACES,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { create } from './create';
import { get } from './get';
import { leave } from './leave';
import { listMine } from './listMine';
import { remove } from './remove';
import { removeMember } from './removeMember';
import { setMemberRole } from './setMemberRole';
import { transferOwnership } from './transferOwnership';
import { update } from './update';

const user = (id: string, extra: Partial<IUserDocument> = {}) => ({ id, ...extra }) as IUserDocument;
const owner = user('owner');
const admin = user('admin');
const member = user('member');
const stranger = user('stranger');

const freshSpace = (over: Partial<ISpaceDocument> = {}): ISpaceDocument =>
  ({
    id: 'space1',
    name: 'Team',
    description: null,
    ownerUserId: 'owner',
    members: [
      { userId: 'admin', role: 'admin', joinedVia: 'invite', joinedAt: new Date() },
      { userId: 'member', role: 'member', joinedVia: 'link', joinedAt: new Date() },
    ],
    removedUserIds: [],
    parentOrganizationId: null,
    ...over,
  }) as ISpaceDocument;

describe('spaceService', () => {
  let space: ISpaceDocument | null;
  let org: IOrganizationDocument | null;
  let usersById: Record<string, IUserDocument | null>;
  let ownedCount: number;

  const buildAdapters = () => {
    const spaces = {
      findLiveById: vi.fn(async () => space),
      create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'new', ...data }) as unknown as ISpaceDocument),
      countOwned: vi.fn(async () => ownedCount),
      listForUser: vi.fn(async () => (space ? [space] : [])),
      updateDetails: vi.fn(async () => space),
      softDelete: vi.fn(async () => true),
      removeMember: vi.fn(async () => space),
      setMemberRole: vi.fn(async () => space),
      transferOwnership: vi.fn(async () => space),
    };
    const organizations = { findById: vi.fn(async () => org) };
    const users = {
      findById: vi.fn(async (id: string) => usersById[id] ?? null),
      findByIds: vi.fn(async () => []),
      update: vi.fn(),
    };
    const invites = { revokeAllForDocument: vi.fn(async () => 2) };
    return { spaces, organizations, users, invites };
  };
  let db: ReturnType<typeof buildAdapters>;

  // Spaces never touch billing, seats or the org pointer: no user or organization write may happen.
  const expectNoOrgOrUserWrite = () => {
    expect(db.users.update).not.toHaveBeenCalled();
    expect(Object.keys(db.organizations)).toEqual(['findById']);
  };

  beforeEach(() => {
    space = freshSpace();
    org = { id: 'org1', userId: 'owner', adminUserIds: [] } as unknown as IOrganizationDocument;
    usersById = { admin };
    ownedCount = 0;
    db = buildAdapters();
  });

  describe('create', () => {
    const run = (actor = owner, canCreate = true, params: Record<string, unknown> = { name: ' Team ' }) =>
      create(actor, params as never, { db, gate: { canCreate } } as never);

    it('creates a Space owned by the caller with no member rows', async () => {
      const result = await run();
      expect(db.spaces.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Team', ownerUserId: 'owner', members: [], removedUserIds: [] })
      );
      expect(result.ownerUserId).toBe('owner');
      expectNoOrgOrUserWrite();
    });

    it('refuses without paid standing and carries the code', async () => {
      await expect(run(owner, false)).rejects.toMatchObject({
        constructor: ForbiddenError,
        additionalInfo: { code: 'SPACE_CREATION_REQUIRES_PAID_STANDING' },
      });
      expect(db.spaces.create).not.toHaveBeenCalled();
    });

    it('refuses at the owned-Space cap', async () => {
      ownedCount = MAX_OWNED_SPACES;
      await expect(run()).rejects.toMatchObject({
        constructor: ForbiddenError,
        additionalInfo: { code: 'SPACE_LIMIT_REACHED' },
      });
    });

    it('requires administering the parent organization', async () => {
      await expect(run(stranger, true, { name: 'T', parentOrganizationId: 'org1' })).rejects.toBeInstanceOf(
        NotFoundError
      );
      await expect(run(owner, true, { name: 'T', parentOrganizationId: 'org1' })).resolves.toBeTruthy();
      expect(db.spaces.create).toHaveBeenCalledWith(expect.objectContaining({ parentOrganizationId: 'org1' }));
    });

    it('rejects a missing parent organization as not found', async () => {
      org = null;
      await expect(run(owner, true, { name: 'T', parentOrganizationId: 'gone' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('get and listMine', () => {
    it('returns the Space and its people to a member', async () => {
      const result = await get(member, { spaceId: 'space1' }, { db } as never);
      expect(result.space.id).toBe('space1');
      expect(db.users.findByIds).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    });

    it('answers a non-member and a missing Space identically', async () => {
      const forbidden = await get(stranger, { spaceId: 'space1' }, { db } as never).catch(e => e);
      space = null;
      const missing = await get(stranger, { spaceId: 'space1' }, { db } as never).catch(e => e);
      expect(forbidden).toBeInstanceOf(NotFoundError);
      expect(forbidden.message).toBe('Space not found');
      expect(missing.message).toBe(forbidden.message);
    });

    it('lists the caller own Spaces', async () => {
      expect(await listMine(owner, {}, { db } as never)).toHaveLength(1);
      expect(db.spaces.listForUser).toHaveBeenCalledWith('owner');
    });
  });

  describe('update', () => {
    const run = (actor: IUserDocument, params: Record<string, unknown> = { name: 'New' }) =>
      update(actor, { spaceId: 'space1', ...params } as never, { db } as never);

    it('lets the owner and an admin edit, and refuses a plain member', async () => {
      await run(owner);
      await run(admin);
      await expect(run(member)).rejects.toBeInstanceOf(ForbiddenError);
      expect(db.spaces.updateDetails).toHaveBeenCalledTimes(2);
      expectNoOrgOrUserWrite();
    });

    it('needs administrator rights on a new parent, and null clears it', async () => {
      await expect(run(admin, { parentOrganizationId: 'org1' })).rejects.toBeInstanceOf(NotFoundError);
      await run(owner, { parentOrganizationId: null });
      expect(db.spaces.updateDetails).toHaveBeenCalledWith('space1', { parentOrganizationId: null });
    });
  });

  describe('remove', () => {
    const run = (actor: IUserDocument) => remove(actor, { spaceId: 'space1' }, { db } as never);

    it('soft-deletes and revokes the live invites, owner only', async () => {
      await run(owner);
      expect(db.spaces.softDelete).toHaveBeenCalledWith('space1', 'owner');
      expect(db.invites.revokeAllForDocument).toHaveBeenCalledWith('space1', InviteType.Space);
      await expect(run(admin)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(stranger)).rejects.toBeInstanceOf(NotFoundError);
      expectNoOrgOrUserWrite();
    });

    it('does not revoke invites when the delete lost a race', async () => {
      db.spaces.softDelete.mockResolvedValueOnce(false);
      await expect(run(owner)).rejects.toBeInstanceOf(NotFoundError);
      expect(db.invites.revokeAllForDocument).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    const run = (actor: IUserDocument) => leave(actor, { spaceId: 'space1' }, { db } as never);

    it('refuses the owner', async () => {
      await expect(run(owner)).rejects.toThrow(
        new ConflictError('Transfer ownership or delete the space before leaving')
      );
      expect(db.spaces.removeMember).not.toHaveBeenCalled();
    });

    it('removes a member without blocking a rejoin', async () => {
      await run(member);
      expect(db.spaces.removeMember).toHaveBeenCalledWith('space1', 'member', { block: false });
      expectNoOrgOrUserWrite();
    });

    it('is idempotent when a concurrent change already removed the row', async () => {
      db.spaces.removeMember.mockResolvedValueOnce(null as never);
      await expect(run(member)).resolves.toBeUndefined();
    });
  });

  describe('removeMember', () => {
    const run = (actor: IUserDocument, userId: string) =>
      removeMember(actor, { spaceId: 'space1', userId }, { db } as never);

    it('lets the owner remove anyone, with a block', async () => {
      await run(owner, 'admin');
      await run(owner, 'member');
      expect(db.spaces.removeMember).toHaveBeenNthCalledWith(1, 'space1', 'admin', { block: true });
      expect(db.spaces.removeMember).toHaveBeenNthCalledWith(2, 'space1', 'member', { block: true });
      expectNoOrgOrUserWrite();
    });

    it('lets an admin remove plain members only', async () => {
      await run(admin, 'member');
      await expect(run(admin, 'admin')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(admin, 'owner')).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a plain member and reports an unknown target', async () => {
      await expect(run(member, 'admin')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(owner, 'nobody')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('setMemberRole', () => {
    const run = (actor: IUserDocument) =>
      setMemberRole(actor, { spaceId: 'space1', userId: 'member', role: 'admin' }, { db } as never);

    it('is owner only', async () => {
      await run(owner);
      expect(db.spaces.setMemberRole).toHaveBeenCalledWith('space1', 'member', 'admin');
      await expect(run(admin)).rejects.toBeInstanceOf(ForbiddenError);
      expectNoOrgOrUserWrite();
    });

    it('reports a target that is not a member', async () => {
      db.spaces.setMemberRole.mockResolvedValueOnce(null as never);
      await expect(run(owner)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('transferOwnership', () => {
    const run = (actor: IUserDocument, newOwnerId = 'admin') =>
      transferOwnership(actor, { spaceId: 'space1', newOwnerId }, { db } as never);

    it('hands the Space to an admin and keeps the parent when the new owner administers it', async () => {
      space = freshSpace({ parentOrganizationId: 'org1' });
      org = {
        id: 'org1',
        userId: 'someone',
        adminUserIds: ['admin'],
        users: [{ userId: 'admin' }],
      } as unknown as IOrganizationDocument;
      await run(owner);
      expect(db.spaces.transferOwnership).toHaveBeenCalledWith('space1', 'owner', 'admin', { clearParent: false });
      expectNoOrgOrUserWrite();
    });

    it('clears the parent when the new owner does not administer it', async () => {
      space = freshSpace({ parentOrganizationId: 'org1' });
      await run(owner);
      expect(db.spaces.transferOwnership).toHaveBeenCalledWith('space1', 'owner', 'admin', { clearParent: true });
    });

    it('is owner only and only to an existing admin', async () => {
      await expect(run(admin)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run(owner, 'member')).rejects.toBeInstanceOf(BadRequestError);
      await expect(run(owner, 'owner')).rejects.toBeInstanceOf(BadRequestError);
      expect(db.spaces.transferOwnership).not.toHaveBeenCalled();
    });

    it('refuses a banned new owner and reports a lost race', async () => {
      usersById.admin = user('admin', { isBanned: true });
      await expect(run(owner)).rejects.toBeInstanceOf(ConflictError);
      usersById.admin = admin;
      db.spaces.transferOwnership.mockResolvedValueOnce(null as never);
      await expect(run(owner)).rejects.toBeInstanceOf(ConflictError);
    });
  });
});
